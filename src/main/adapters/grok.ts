import { findBinary, isExecutable } from "./binary"
import { buildGrokArgs } from "./args"
import { runProcess, type RunningProcess } from "./process-runner"
import {
  beginAssistant,
  extractTextFromContent,
  extractTouchedFiles,
  finishTurn,
  newSnapshot,
  noteSnapshotDelta,
  pushDelta,
  safeJson,
  snapshotDelta,
  toolUseBlock,
  touchedFileFromTool,
  type StreamTurn,
} from "./stream-parse"
import { readUsage } from "./usage"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import type { TurnUsage } from "@shared/types"
import type {
  AdapterCallbacks,
  AdapterSendOpts,
  AdapterStartOpts,
  AgentAdapter,
} from "./types"

/**
 * Grok Build headless adapter.
 * Uses: grok -p/--single PROMPT --output-format streaming-json --cwd …
 */
export class GrokAdapter implements AgentAdapter {
  readonly id = "grok" as const
  private binary: string | null
  private sessions = new Map<
    string,
    {
      cwd: string
      grokSession?: string
      binaryPath?: string
      proc?: RunningProcess
      /** Set by abort() so the dying turn hands the session to the next send. */
      aborting?: boolean
    }
  >()

  constructor() {
    this.binary = findBinary(["grok", `${process.env.HOME}/.grok/bin/grok`])
  }

  get available(): boolean {
    return Boolean(this.binary)
  }

  refresh(): void {
    this.binary = findBinary(["grok", `${process.env.HOME}/.grok/bin/grok`])
  }

  async start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void> {
    const bin = opts.binaryPath || this.binary
    if (!bin) throw new Error("Grok Build CLI not found (grok)")
    // A bad Settings override must fail here, not as a silent ENOENT per turn.
    if (opts.binaryPath && !isExecutable(opts.binaryPath)) {
      throw new Error(`Grok binary is not executable: ${opts.binaryPath}`)
    }
    this.sessions.set(opts.sessionId, {
      cwd: opts.cwd,
      binaryPath: opts.binaryPath,
      grokSession: opts.resumeId,
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
    if (!bin) throw new Error("Grok Build CLI not found")
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

    const mode =
      opts?.permissionMode ??
      (process.env.CHAT_HUB_PERMISSION as
        | "yolo"
        | "acceptEdits"
        | "default"
        | undefined) ??
      DEFAULT_PERMISSION_MODE

    const args = buildGrokArgs({
      message,
      cwd: state.cwd,
      permissionMode: mode,
      model: opts?.model,
      attachments: opts?.attachments,
      resumeId: state.grokSession,
    })

    cb.onSessionEvent({
      type: "session.status",
      id: sessionId,
      status: "running",
    })

    let turn: StreamTurn | null = null
    let sawText = false
    let usage: TurnUsage | null = null
    const snapshot = newSnapshot()
    const stderr: string[] = []

    const proc = runProcess({
      command: bin,
      args,
      cwd: state.cwd,
      env: opts?.env,
      onStdoutLine: (line) => {
        const ev = safeJson(line)
        if (!ev) {
          if (line.trim()) {
            if (!turn) turn = beginAssistant(sessionId, cb)
            pushDelta(turn, sessionId, line + "\n", cb)
            sawText = true
          }
          return
        }

        const gsid =
          (typeof ev.session_id === "string" && ev.session_id) ||
          (typeof ev.sessionId === "string" && ev.sessionId) ||
          ""
        if (gsid && gsid !== state.grokSession) {
          state.grokSession = gsid
          cb.onAgentSession?.(sessionId, gsid)
        }

        // Grok tags its totals onto whichever line it feels like; last one wins.
        usage = readUsage(ev) ?? usage

        const type = String(ev.type ?? ev.event ?? "")

        // text deltas
        const delta =
          (typeof ev.delta === "string" && ev.delta) ||
          (typeof ev.text === "string" &&
          (type.includes("delta") || type.includes("stream"))
            ? ev.text
            : "") ||
          extractPartial(ev)

        if (delta) {
          if (!turn) turn = beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, delta, cb)
          // Grok streams deltas AND repeats the finished message: the snapshot
          // has to know what the deltas already put on screen.
          noteSnapshotDelta(snapshot, delta)
          sawText = true
          return
        }

        if (
          type === "assistant" ||
          type === "message" ||
          type === "response" ||
          type === "result"
        ) {
          const msg = (ev.message ?? ev) as Record<string, unknown>
          const text =
            extractTextFromContent(msg.content) ||
            (typeof msg.text === "string" ? msg.text : "") ||
            (typeof ev.result === "string" ? ev.result : "") ||
            (typeof ev.content === "string" ? ev.content : "")
          if (text) {
            if (!turn) turn = beginAssistant(sessionId, cb)
            // Same trap as Claude had: diffing a per-message snapshot against
            // the whole run's buffer silences every message after the first
            // (its text is shorter than the buffer) and slices any that is
            // longer at a meaningless offset.
            const msgId = typeof msg.id === "string" ? msg.id : undefined
            const extra = snapshotDelta(snapshot, msgId, text)
            if (extra) pushDelta(turn, sessionId, extra, cb)
            sawText = true
          }
          const touched = extractTouchedFiles(msg.content)
          if (touched.length) {
            if (!turn) turn = beginAssistant(sessionId, cb)
            cb.onTouchedFiles?.(sessionId, turn.messageId, touched)
          }
        }

        if (type === "tool" || type === "tool_use") {
          const name = String(ev.name ?? "tool")
          if (!turn) turn = beginAssistant(sessionId, cb)
          // A bare tool name says nothing about what the agent did to the repo.
          const input = ev.input ?? ev.arguments
          pushDelta(turn, sessionId, toolUseBlock(name, input), cb)
          sawText = true
          const file = touchedFileFromTool(name, input)
          if (file) cb.onTouchedFiles?.(sessionId, turn.messageId, [file])
        }
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
          if (!sawText) {
            const t = beginAssistant(sessionId, cb)
            pushDelta(
              t,
              sessionId,
              `Grok exited with code ${code}.\n\n\`\`\`\n${stderr.slice(-8).join("\n") || "(no stderr output)"}\n\`\`\``,
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

function extractPartial(ev: Record<string, unknown>): string {
  if (ev.delta && typeof ev.delta === "object") {
    const d = ev.delta as Record<string, unknown>
    if (typeof d.text === "string") return d.text
    if (typeof d.content === "string") return d.content
  }
  return ""
}
