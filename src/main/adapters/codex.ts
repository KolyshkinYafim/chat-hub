import { homedir } from "node:os"
import { join } from "node:path"
import { findBinary, isExecutable } from "./binary"
import { buildCodexArgs } from "./args"
import { runProcess, type RunningProcess } from "./process-runner"
import {
  beginAssistant,
  finishTurn,
  pushDelta,
  safeJson,
  toolUseBlock,
  type StreamTurn,
} from "./stream-parse"
import { readUsage } from "./usage"
import type { TurnUsage } from "@shared/types"
import type {
  AdapterCallbacks,
  AdapterSendOpts,
  AdapterStartOpts,
  AgentAdapter,
} from "./types"

/**
 * Codex CLI adapter (when `codex` is installed).
 * Tries common headless flags; degrades gracefully if binary missing.
 */
const CODEX_NAMES = [
  "codex",
  join(homedir(), ".codex", "bin", "codex"),
  join(homedir(), ".local", "bin", "codex"),
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/MacOS/codex",
]

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const
  private binary: string | null
  private sessions = new Map<
    string,
    {
      cwd: string
      binaryPath?: string
      proc?: RunningProcess
      /** codex `thread_id` — what `exec resume <id>` continues. */
      threadId?: string
      /** Set by abort() so the dying turn hands the session to the next send. */
      aborting?: boolean
    }
  >()

  constructor() {
    this.binary = findBinary(CODEX_NAMES)
  }

  get available(): boolean {
    return Boolean(this.binary)
  }

  refresh(): void {
    this.binary = findBinary(CODEX_NAMES)
  }

  async start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void> {
    const bin = opts.binaryPath || this.binary
    if (!bin) {
      throw new Error(
        "Codex CLI not found. Install Codex CLI and ensure `codex` is on PATH.",
      )
    }
    // A bad Settings override must fail here, not as a silent ENOENT per turn.
    if (opts.binaryPath && !isExecutable(opts.binaryPath)) {
      throw new Error(`Codex binary is not executable: ${opts.binaryPath}`)
    }
    this.sessions.set(opts.sessionId, {
      cwd: opts.cwd,
      binaryPath: opts.binaryPath,
      threadId: opts.resumeId,
    })
    cb.onSessionEvent({
      type: "session.status",
      id: opts.sessionId,
      status: "idle",
    })
  }

  async send(
    sessionId: string,
    message: string,
    cb: AdapterCallbacks,
    opts?: AdapterSendOpts,
  ): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error("Session not started")
    const bin = opts?.binaryPath || state.binaryPath || this.binary
    if (!bin) throw new Error("Codex CLI not found")
    if (opts?.binaryPath) state.binaryPath = opts.binaryPath

    // One turn at a time — refuse rather than kill the in-flight turn. After an
    // explicit Stop the dying process hands the session over instead.
    if (state.proc) {
      if (!state.aborting) {
        throw new Error(
          "This session is already running a turn — stop it or wait for it to finish.",
        )
      }
      state.proc = undefined
      state.aborting = false
    }

    const args = buildCodexArgs({
      message,
      cwd: state.cwd,
      permissionMode: opts?.permissionMode ?? "yolo",
      model: opts?.model,
      attachments: opts?.attachments,
      resumeId: state.threadId,
    })

    cb.onSessionEvent({
      type: "session.status",
      id: sessionId,
      status: "running",
    })

    let turn: StreamTurn | null = null
    let usage: TurnUsage | null = null
    const stderr: string[] = []

    const proc = runProcess({
      command: bin,
      args,
      cwd: state.cwd,
      env: opts?.env,
      onStdoutLine: (line) => {
        const ev = safeJson(line)
        // `--json` puts events on stdout and logs on stderr, but a stray line
        // (a panic, an older codex) must not be swallowed silently.
        if (!ev) {
          if (!line.trim()) return
          turn ??= beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, line + "\n", cb)
          return
        }

        usage = readUsage(ev) ?? usage

        if (ev.type === "thread.started") {
          // The thread id is what `exec resume <id>` needs; persisting it here
          // is the whole difference between a chat and a series of one-shots.
          const id = typeof ev.thread_id === "string" ? ev.thread_id : undefined
          if (id && id !== state.threadId) {
            state.threadId = id
            cb.onAgentSession?.(sessionId, id)
          }
          return
        }

        // Only `item.completed` carries the finished payload; `item.started`
        // repeats it in progress and would double every card.
        if (ev.type !== "item.completed") return
        const item = ev.item && typeof ev.item === "object"
          ? (ev.item as Record<string, unknown>)
          : null
        if (!item) return
        const rendered = renderCodexItem(item)
        if (!rendered) return
        turn ??= beginAssistant(sessionId, cb)
        pushDelta(turn, sessionId, rendered, cb)
      },
      onStderrLine: (line) => {
        stderr.push(line)
        if (stderr.length > 40) stderr.shift()
      },
      onSpawnError: (err) => {
        // ENOENT/EACCES never reaches stderr — without this the turn dies silent.
        stderr.push(err.message)
      },
      onExit: (code) => {
        const messageId = turn?.messageId
        finishTurn(turn, sessionId, cb)
        if (usage) cb.onUsage?.(sessionId, usage, messageId)
        // A newer turn may already own this session (Stop then immediate
        // resend): a dead process must not overwrite the live turn's status.
        if (state.proc !== proc) return
        state.proc = undefined
        state.aborting = false
        if (code === 0) {
          cb.onSessionEvent({
            type: "session.status",
            id: sessionId,
            status: "done",
          })
          cb.onSessionEvent({
            type: "session.ended",
            id: sessionId,
            reason: "done",
          })
        } else if (code === null) {
          cb.onSessionEvent({
            type: "session.status",
            id: sessionId,
            status: "idle",
          })
        } else {
          if (!turn) {
            const t = beginAssistant(sessionId, cb)
            pushDelta(
              t,
              sessionId,
              `Codex exited with code ${code}.\n\n\`\`\`\n${stderr.slice(-10).join("\n") || "(no stderr output)"}\n\`\`\``,
              cb,
            )
            finishTurn(t, sessionId, cb)
          }
          cb.onSessionEvent({
            type: "session.status",
            id: sessionId,
            status: "error",
          })
          cb.onSessionEvent({
            type: "session.ended",
            id: sessionId,
            reason: "error",
          })
        }
      },
    })

    state.proc = proc
    await proc.done
  }

  async abort(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state?.proc) return
    state.aborting = true
    state.proc.abort()
  }

  async dispose(sessionId: string): Promise<void> {
    await this.abort(sessionId)
    this.sessions.delete(sessionId)
  }
}

/**
 * One `item.completed` payload → transcript text.
 *
 * Item types verified against codex-cli 0.146.0: agent_message, reasoning,
 * command_execution, file_change, mcp_tool_call, todo_list, web_search, error.
 * An unknown type still gets a card rather than a dumped JSON line — codex
 * adds item types between releases and silence would hide real work.
 */
export function renderCodexItem(item: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const type = str(item.type)

  switch (type) {
    case "agent_message":
      return str(item.text)
    // Reasoning is a summary, not an answer — keeping it out of the bubble is
    // what stops the transcript reading like a stream of consciousness.
    case "reasoning":
      return ""
    case "command_execution":
      return toolUseBlock("Bash", { command: str(item.command) || str(item.cmd) })
    case "file_change": {
      const changes = Array.isArray(item.changes)
        ? (item.changes as Record<string, unknown>[])
        : []
      if (changes.length === 1) {
        return toolUseBlock("Edit", { file_path: str(changes[0]?.path) })
      }
      const head = changes.map((c) => `${str(c.kind) || "edit"} ${str(c.path)}`)
      return `\n\n\`\`\`tool:Edit\n${head.join("\n") || "(no changes)"}\n\`\`\`\n\n`
    }
    case "mcp_tool_call":
      return toolUseBlock(str(item.tool) || str(item.name) || "MCP", item.arguments ?? item.input)
    case "todo_list": {
      const items = Array.isArray(item.items) ? (item.items as Record<string, unknown>[]) : []
      if (!items.length) return ""
      const lines = items.map((t) => {
        const done = t.completed === true || str(t.status) === "completed"
        return `${done ? "- [x]" : "- [ ]"} ${str(t.text) || str(t.title)}`
      })
      return `\n\n${lines.join("\n")}\n\n`
    }
    case "web_search":
      return toolUseBlock("WebSearch", { pattern: str(item.query) })
    case "error":
      return `\n\n\`\`\`\n${str(item.message) || str(item.text) || "Codex reported an error."}\n\`\`\`\n\n`
    default:
      return toolUseBlock(type || "item", item)
  }
}
