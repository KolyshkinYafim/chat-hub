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
  opencodeAutoApprove,
} from "@shared/permission"
import type {
  AdapterCallbacks,
  AdapterSendOpts,
  AdapterStartOpts,
  AgentAdapter,
} from "./types"

/**
 * OpenCode adapter via `opencode run --format json`.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode" as const
  private binary: string | null
  private sessions = new Map<
    string,
    { cwd: string; opencodeSession?: string; proc?: RunningProcess }
  >()

  constructor() {
    this.binary = findBinary(["opencode"])
  }

  get available(): boolean {
    return Boolean(this.binary)
  }

  refresh(): void {
    this.binary = findBinary(["opencode"])
  }

  async start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void> {
    if (!this.binary) throw new Error("OpenCode CLI not found (opencode)")
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
    if (!bin) throw new Error("OpenCode CLI not found")
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

    const args = ["run", message, "--format", "json", "--dir", state.cwd]
    if (opts?.model) {
      args.push("--model", opts.model)
    }
    if (opts?.attachments?.length) {
      for (const f of opts.attachments) {
        args.push("--file", f)
      }
    }
    if (state.opencodeSession) {
      args.push("--session", state.opencodeSession)
    }
    // Default YOLO: --auto. Opt out via permission mode "default".
    if (
      opencodeAutoApprove(mode) ||
      process.env.CHAT_HUB_OPENCODE_AUTO === "1"
    ) {
      args.push("--auto")
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

        const sid =
          (typeof ev.sessionID === "string" && ev.sessionID) ||
          (typeof ev.sessionId === "string" && ev.sessionId) ||
          (typeof ev.session_id === "string" && ev.session_id) ||
          undefined
        if (sid) state.opencodeSession = sid

        const type = String(ev.type ?? ev.event ?? "")

        // OpenCode emits various event shapes — be liberal
        const text =
          (typeof ev.part === "object" &&
            ev.part &&
            typeof (ev.part as { text?: string }).text === "string" &&
            (ev.part as { text: string }).text) ||
          (typeof ev.text === "string" && ev.text) ||
          (typeof ev.message === "object" &&
            extractTextFromContent(
              (ev.message as { content?: unknown }).content,
            )) ||
          (typeof ev.content === "string" && ev.content) ||
          ""

        if (
          text &&
          (type.includes("text") ||
            type.includes("message") ||
            type.includes("part") ||
            type === "message.part.updated" ||
            type === "message.updated" ||
            !type)
        ) {
          if (!turn) turn = beginAssistant(sessionId, cb)
          // Avoid replaying entire buffer: only append growth
          if (text.startsWith(turn.text)) {
            const extra = text.slice(turn.text.length)
            if (extra) pushDelta(turn, sessionId, extra, cb)
          } else if (!turn.text.includes(text)) {
            pushDelta(turn, sessionId, text, cb)
          }
          sawText = true
        }

        if (type.includes("tool") || type === "tool.execute") {
          const name = String(
            (ev.tool as string) ||
              (ev.name as string) ||
              (ev.part as { tool?: string } | undefined)?.tool ||
              "tool",
          )
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
              `OpenCode exited with code ${code}.\n\n\`\`\`\n${stderr.slice(-8).join("\n")}\n\`\`\`\n\nTip: set CHAT_HUB_OPENCODE_AUTO=1 to auto-approve tools.`,
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
