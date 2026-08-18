import { findBinary, isExecutable } from "./binary"
import { buildOpenCodeArgs } from "./args"
import { runProcess, type RunningProcess } from "./process-runner"
import {
  beginAssistant,
  extractTextFromContent,
  finishTurn,
  newSnapshot,
  pushDelta,
  safeJson,
  snapshotDelta,
  toolUseBlock,
  type StreamTurn,
} from "./stream-parse"
import { readUsage } from "./usage"
import { renderCliFailure } from "./failure-message"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import type { TurnUsage } from "@shared/types"
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
    {
      cwd: string
      opencodeSession?: string
      binaryPath?: string
      proc?: RunningProcess
      /** Set by abort() so the dying turn hands the session to the next send. */
      aborting?: boolean
    }
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
    const bin = opts.binaryPath || this.binary
    if (!bin) throw new Error("OpenCode CLI not found (opencode)")
    // A bad Settings override must fail here, not as a silent ENOENT per turn.
    if (opts.binaryPath && !isExecutable(opts.binaryPath)) {
      throw new Error(`OpenCode binary is not executable: ${opts.binaryPath}`)
    }
    this.sessions.set(opts.sessionId, {
      cwd: opts.cwd,
      binaryPath: opts.binaryPath,
      opencodeSession: opts.resumeId,
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
    if (!bin) throw new Error("OpenCode CLI not found")
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

    const args = buildOpenCodeArgs({
      message,
      cwd: state.cwd,
      permissionMode: mode,
      model: opts?.model,
      attachments: opts?.attachments,
      resumeId: state.opencodeSession,
    })
    cb.onSessionEvent({
      type: "session.status",
      id: sessionId,
      status: "running",
    })

    let turn: StreamTurn | null = null
    let usage: TurnUsage | null = null
    const snap = newSnapshot()
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
          }
          return
        }

        const sid =
          (typeof ev.sessionID === "string" && ev.sessionID) ||
          (typeof ev.sessionId === "string" && ev.sessionId) ||
          (typeof ev.session_id === "string" && ev.session_id) ||
          undefined
        if (sid && sid !== state.opencodeSession) {
          state.opencodeSession = sid
          cb.onAgentSession?.(sessionId, sid)
        }

        // `message.updated` carries the assistant message's own totals; the
        // last one of a turn is the whole turn.
        usage = readUsage(ev) ?? usage

        const type = String(ev.type ?? ev.event ?? "")

        // `opencode run --format json` prints flat events ({type, part, …});
        // the server bus wraps the same part under `properties`.
        const part = asRecord(ev.part) ?? asRecord(asRecord(ev.properties)?.part)

        // Tool-ness lives in the part, not in the event name.
        if (part?.type === "tool" || type.includes("tool")) {
          const name = String(part?.tool ?? ev.tool ?? ev.name ?? "tool")
          const toolState = asRecord(part?.state)
          if (!turn) turn = beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, toolUseBlock(name, toolState?.input), cb)
          return
        }

        const text =
          (typeof part?.text === "string" && part.text) ||
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
          // Each text part is its own dedupe unit: diffing against the whole
          // bubble drops a part whose text repeats one already in it.
          const partId = typeof part?.id === "string" ? part.id : undefined
          const extra = snapshotDelta(snap, partId, text)
          if (extra) pushDelta(turn, sessionId, extra, cb)
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
        if (usage) cb.onUsage?.(sessionId, usage, messageId)
        // A newer turn may already own this session (Stop then immediate
        // resend): a dead process must not overwrite the live turn's status.
        if (state.proc !== proc) {
          finishTurn(turn, sessionId, cb)
          return
        }
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
          if (!turn) turn = beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, renderCliFailure("OpenCode", code, stderr), cb)
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
        finishTurn(turn, sessionId, cb)
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

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined
}
