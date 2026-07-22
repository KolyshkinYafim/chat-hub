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
  claudePermissionArgs,
} from "@shared/permission"
import type {
  AdapterCallbacks,
  AdapterSendOpts,
  AdapterStartOpts,
  AgentAdapter,
} from "./types"

/**
 * Claude Code headless adapter.
 * Uses: claude -p --output-format stream-json --verbose --include-partial-messages
 * Multi-turn via --resume <session_id>.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude" as const
  private binary: string | null
  private sessions = new Map<
    string,
    { cwd: string; claudeSessionId?: string; proc?: RunningProcess }
  >()

  constructor() {
    this.binary = findBinary(["claude"])
  }

  get available(): boolean {
    return Boolean(this.binary)
  }

  refresh(): void {
    this.binary = findBinary(["claude"])
  }

  async start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void> {
    if (!this.binary) throw new Error("Claude Code CLI not found (claude)")
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
    if (!bin) throw new Error("Claude Code CLI not found")
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error("Session not started")

    // One turn at a time
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
      "-p",
      message,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Default YOLO: full bypass for unattended daily coding
      ...claudePermissionArgs(mode),
    ]
    if (state.claudeSessionId) {
      args.push("--resume", state.claudeSessionId)
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
          // plain fallback
          if (!turn) turn = beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, line + "\n", cb)
          sawText = true
          return
        }

        const type = String(ev.type ?? "")

        // Capture session id for resume
        const sid =
          (typeof ev.session_id === "string" && ev.session_id) ||
          (ev.message &&
          typeof ev.message === "object" &&
          typeof (ev.message as { session_id?: string }).session_id === "string"
            ? (ev.message as { session_id: string }).session_id
            : undefined)
        if (sid) state.claudeSessionId = sid

        if (type === "system" && ev.subtype === "init") {
          if (typeof ev.session_id === "string") {
            state.claudeSessionId = ev.session_id
          }
          return
        }

        // Partial tokens
        if (
          type === "stream_event" ||
          type === "content_block_delta" ||
          (ev.event && typeof ev.event === "object")
        ) {
          const delta = extractPartialDelta(ev)
          if (delta) {
            if (!turn) turn = beginAssistant(sessionId, cb)
            pushDelta(turn, sessionId, delta, cb)
            sawText = true
          }
          return
        }

        if (type === "assistant") {
          const msg = ev.message as Record<string, unknown> | undefined
          const text = extractTextFromContent(msg?.content ?? ev.content)
          if (text) {
            // Full assistant message — prefer as complete snapshot if no partials
            if (!turn) {
              turn = beginAssistant(sessionId, cb)
              pushDelta(turn, sessionId, text, cb)
            } else if (!sawText) {
              pushDelta(turn, sessionId, text, cb)
            } else if (text.length > turn.text.length) {
              // append only new suffix if model re-emits full content
              const extra = text.slice(turn.text.length)
              if (extra) pushDelta(turn, sessionId, extra, cb)
            }
            sawText = true
          }
          return
        }

        if (type === "result") {
          // final envelope; text may already be streamed
          if (!turn && typeof ev.result === "string") {
            turn = beginAssistant(sessionId, cb)
            pushDelta(turn, sessionId, ev.result, cb)
            sawText = true
          }
          return
        }

        // tool_use as standalone
        if (type === "tool_use" || type === "tool_result") {
          const name = String(ev.name ?? type)
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
        turn = null
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
          // aborted
          cb.onSessionEvent({
            type: "session.status",
            id: sessionId,
            status: "idle",
          })
        } else {
          const errTail = stderr.slice(-8).join("\n")
          if (!sawText && errTail) {
            const t = beginAssistant(sessionId, cb)
            pushDelta(
              t,
              sessionId,
              `Claude exited with code ${code}.\n\n\`\`\`\n${errTail}\n\`\`\``,
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

function extractPartialDelta(ev: Record<string, unknown>): string {
  // common shapes across claude versions
  if (typeof ev.delta === "string") return ev.delta
  if (ev.delta && typeof ev.delta === "object") {
    const d = ev.delta as Record<string, unknown>
    if (typeof d.text === "string") return d.text
    if (typeof d.partial_json === "string") return ""
  }
  const event = ev.event as Record<string, unknown> | undefined
  if (event) {
    if (typeof event.text === "string") return event.text
    const delta = event.delta as Record<string, unknown> | undefined
    if (delta && typeof delta.text === "string") return delta.text
    if (event.type === "content_block_delta" && delta) {
      if (typeof delta.text === "string") return delta.text
    }
  }
  if (typeof ev.text === "string") return ev.text
  return ""
}
