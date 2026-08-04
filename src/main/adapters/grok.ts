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
  touchedFileFromTool,
  type StreamTurn,
} from "./stream-parse"
import { readUsage } from "./usage"
import { renderCliFailure } from "./failure-message"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import type { AgentTurnItem, TurnUsage } from "@shared/types"
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
    let usage: TurnUsage | null = null
    const snapshot = newSnapshot()
    const stderr: string[] = []
    let sawThought = false

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

        // Grok exposes raw thought chunks, not a user-safe reasoning summary.
        // Record only lifecycle state; never copy chain-of-thought into the UI.
        if (type === "thought") {
          sawThought = true
          if (!turn) turn = beginAssistant(sessionId, cb)
          cb.onTurnItem(sessionId, turn.messageId, {
            id: "grok-reasoning",
            kind: "reasoning",
            status: "running",
            summary: "Grok is reasoning…",
          })
          return
        }

        const action = extractGrokAction(ev, type)
        if (action) {
          if (!turn) turn = beginAssistant(sessionId, cb)
          cb.onTurnItem(sessionId, turn.messageId, action)
          if (action.kind === "tool") {
            const file = touchedFileFromTool(action.name, action.arguments)
            if (file) cb.onTouchedFiles?.(sessionId, turn.messageId, [file])
          }
          return
        }

        // text deltas
        const delta = extractGrokText(ev, type)

        if (delta) {
          if (!turn) turn = beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, delta, cb)
          // Grok streams deltas AND repeats the finished message: the snapshot
          // has to know what the deltas already put on screen.
          noteSnapshotDelta(snapshot, delta)
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
          }
          const touched = extractTouchedFiles(msg.content)
          if (touched.length) {
            if (!turn) turn = beginAssistant(sessionId, cb)
            cb.onTouchedFiles?.(sessionId, turn.messageId, touched)
          }
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
        if (sawThought && turn) {
          cb.onTurnItem(sessionId, turn.messageId, {
            id: "grok-reasoning",
            kind: "reasoning",
            status: code === 0 ? "completed" : "interrupted",
            summary: "Grok reasoning complete",
          })
        }
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
          // Tool output is not a successful answer. Append the failure even
          // after a partial/tool event so the user never sees a dead turn as
          // if it had completed normally.
          if (!turn) turn = beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, renderCliFailure("Grok", code, stderr), cb)
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

/** Normalize documented and forward-compatible Grok action envelopes. */
export function extractGrokAction(
  ev: Record<string, unknown>,
  type = String(ev.type ?? ev.event ?? ""),
): Extract<AgentTurnItem, { kind: "tool" | "command" }> | null {
  const lower = type.toLowerCase()
  const isTool = ["tool", "tool_use", "tool_call", "tool_result", "function_call", "function_result"].includes(lower)
  const isCommand = ["command", "command_execution", "command_start", "command_end"].includes(lower)
  if (!isTool && !isCommand) return null

  const nested = objectValue(ev.tool) ?? objectValue(ev.call) ?? objectValue(ev.function) ?? {}
  const id = stringValue(ev.tool_call_id) ?? stringValue(ev.call_id) ?? stringValue(ev.id) ?? `${lower}-${stringValue(ev.sequence) ?? "event"}`
  const status: AgentTurnItem["status"] = lower.endsWith("result") || lower.endsWith("end") || stringValue(ev.status) === "completed"
    ? "completed"
    : stringValue(ev.status) === "failed" ? "failed" : "running"
  const command = stringValue(ev.command) ?? stringValue(nested.command)
  if (isCommand || command) {
    return {
      id: `grok-${id}`,
      kind: "command",
      status,
      command: command ?? "Command",
      output: stringValue(ev.output) ?? stringValue(ev.result) ?? undefined,
    }
  }
  const name = stringValue(ev.name) ?? stringValue(ev.tool_name) ?? stringValue(nested.name) ?? "Tool"
  return {
    id: `grok-${id}`,
    kind: "tool",
    status,
    name,
    arguments: ev.input ?? ev.arguments ?? nested.input ?? nested.arguments,
    result: ev.result ?? ev.output,
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

/** Parse both legacy and Grok Build 0.2.x streaming-json text events. */
export function extractGrokText(
  ev: Record<string, unknown>,
  type = String(ev.type ?? ev.event ?? ""),
): string {
  // Current Grok Build emits { type: "text", data: "..." }. Thinking has
  // the same data shape and must stay out of the user-visible transcript.
  if (type === "text" && typeof ev.data === "string") return ev.data
  if (typeof ev.delta === "string") return ev.delta
  if (
    typeof ev.text === "string" &&
    (type.includes("delta") || type.includes("stream") || type === "text")
  ) {
    return ev.text
  }
  if (ev.delta && typeof ev.delta === "object") {
    const d = ev.delta as Record<string, unknown>
    if (typeof d.text === "string") return d.text
    if (typeof d.content === "string") return d.content
  }
  return ""
}
