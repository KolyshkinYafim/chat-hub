import { findBinary } from "./binary"
import { runProcess, type RunningProcess } from "./process-runner"
import {
  beginAssistant,
  finishTurn,
  pushDelta,
  safeJson,
  type StreamTurn,
} from "./stream-parse"
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
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const
  private binary: string | null
  private sessions = new Map<
    string,
    { cwd: string; proc?: RunningProcess }
  >()

  constructor() {
    this.binary = findBinary(["codex"])
  }

  get available(): boolean {
    return Boolean(this.binary)
  }

  refresh(): void {
    this.binary = findBinary(["codex"])
  }

  async start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void> {
    if (!this.binary) {
      throw new Error(
        "Codex CLI not found. Install Codex CLI and ensure `codex` is on PATH.",
      )
    }
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
    if (!bin) throw new Error("Codex CLI not found")
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error("Session not started")

    state.proc?.abort()

    // Codex CLI flag surface varies by version — use exec-style if present.
    const args = ["exec", message, "--cd", state.cwd]
    // Best-effort yolo flags (ignored if unknown by older codex)
    if ((opts?.permissionMode ?? "yolo") === "yolo") {
      args.push("--full-auto")
    }
    void opts

    cb.onSessionEvent({
      type: "session.status",
      id: sessionId,
      status: "running",
    })

    let turn: StreamTurn | null = null
    const stderr: string[] = []

    const proc = runProcess({
      command: bin,
      args,
      cwd: state.cwd,
      onStdoutLine: (line) => {
        const ev = safeJson(line)
        if (!turn) turn = beginAssistant(sessionId, cb)
        if (ev) {
          const text =
            (typeof ev.text === "string" && ev.text) ||
            (typeof ev.content === "string" && ev.content) ||
            (typeof ev.message === "string" && ev.message) ||
            ""
          if (text) pushDelta(turn, sessionId, text, cb)
          else pushDelta(turn, sessionId, line + "\n", cb)
        } else if (line.trim()) {
          pushDelta(turn, sessionId, line + "\n", cb)
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
          if (!turn) {
            const t = beginAssistant(sessionId, cb)
            pushDelta(
              t,
              sessionId,
              `Codex exited with code ${code}.\n\n\`\`\`\n${stderr.slice(-10).join("\n")}\n\`\`\``,
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
