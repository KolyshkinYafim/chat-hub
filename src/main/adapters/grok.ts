import { findBinary } from "./binary"
import { runProcess, type RunningProcess } from "./process-runner"
import {
  beginAssistant,
  extractTextFromContent,
  finishTurn,
  pushDelta,
  safeJson,
  type StreamTurn,
} from "./stream-parse"
import {
  DEFAULT_PERMISSION_MODE,
  grokPermissionArgs,
} from "@shared/permission"
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
    { cwd: string; grokSession?: string; proc?: RunningProcess }
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
    if (!this.binary) throw new Error("Grok Build CLI not found (grok)")
    this.sessions.set(opts.sessionId, { cwd: opts.cwd })
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
    const bin = this.binary
    if (!bin) throw new Error("Grok Build CLI not found")
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error("Session not started")

    state.proc?.abort()

    const mode =
      opts?.permissionMode ??
      (process.env.CHAT_HUB_PERMISSION as
        | "yolo"
        | "acceptEdits"
        | "default"
        | undefined) ??
      DEFAULT_PERMISSION_MODE

    const args = [
      "--single",
      message,
      "--output-format",
      "streaming-json",
      "--cwd",
      state.cwd,
      ...grokPermissionArgs(mode),
    ]
    if (state.grokSession) {
      args.push("--resume", state.grokSession)
    }

    cb.onSessionEvent({
      type: "session.status",
      id: sessionId,
      status: "running",
    })

    let turn: StreamTurn | null = null
    let sawText = false
    const stderr: string[] = []

    const proc = runProcess({
      command: bin,
      args,
      cwd: state.cwd,
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

        if (typeof ev.session_id === "string") state.grokSession = ev.session_id
        if (typeof ev.sessionId === "string") state.grokSession = ev.sessionId

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
            if (text.length > turn.text.length) {
              pushDelta(turn, sessionId, text.slice(turn.text.length), cb)
            } else if (!turn.text) {
              pushDelta(turn, sessionId, text, cb)
            }
            sawText = true
          }
        }

        if (type === "tool" || type === "tool_use") {
          const name = String(ev.name ?? "tool")
          if (!turn) turn = beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, `\n\n🔧 **${name}**\n`, cb)
          sawText = true
        }
      },
      onStderrLine: (line) => {
        stderr.push(line)
        if (stderr.length > 40) stderr.shift()
      },
      onExit: (code) => {
        finishTurn(turn, sessionId, cb)
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
              `Grok exited with code ${code}.\n\n\`\`\`\n${stderr.slice(-8).join("\n")}\n\`\`\``,
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
        if (state.proc === proc) state.proc = undefined
      },
    })

    state.proc = proc
    await proc.done
  }

  async abort(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.proc?.abort()
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
