import { findBinary, isExecutable } from "./binary"
import { buildClaudeArgs } from "./args"
import { runProcess, type RunningProcess } from "./process-runner"
import {
  beginAssistant,
  beginSnapshotMessage,
  extractTextFromContent,
  finishTurn,
  newSnapshot,
  noteSnapshotDelta,
  pushDelta,
  safeJson,
  snapshotDelta,
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
 * Claude Code headless adapter.
 * Uses: claude -p --output-format stream-json --verbose --include-partial-messages
 * Multi-turn via --resume <session_id>.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude" as const
  private binary: string | null
  private sessions = new Map<
    string,
    {
      cwd: string
      claudeSessionId?: string
      binaryPath?: string
      proc?: RunningProcess
      /** Set by abort() so the dying turn hands the session to the next send. */
      aborting?: boolean
    }
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
    const bin = opts.binaryPath || this.binary
    if (!bin) throw new Error("Claude Code CLI not found (claude)")
    // A bad Settings override must fail here, not as a silent ENOENT per turn.
    if (opts.binaryPath && !isExecutable(opts.binaryPath)) {
      throw new Error(`Claude binary is not executable: ${opts.binaryPath}`)
    }
    this.sessions.set(opts.sessionId, {
      cwd: opts.cwd,
      binaryPath: opts.binaryPath,
      claudeSessionId: opts.resumeId,
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
    if (!bin) throw new Error("Claude Code CLI not found")
    if (opts?.binaryPath) state.binaryPath = opts.binaryPath

    // One turn at a time — refuse rather than kill the in-flight turn. After an
    // explicit Stop the dying process hands the session over instead of being
    // waited on, so a resend never blocks on SIGKILL.
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

    const args = buildClaudeArgs({
      message,
      cwd: state.cwd,
      permissionMode: mode,
      model: opts?.model,
      effort: opts?.effort,
      systemPrompt: opts?.systemPrompt,
      attachments: opts?.attachments,
      resumeId: state.claudeSessionId,
    })

    cb.onSessionEvent({
      type: "session.status",
      id: sessionId,
      status: "running",
    })

    let turn: StreamTurn | null = null
    let sawText = false
    let usage: TurnUsage | null = null
    const snap = newSnapshot()
    const stderr: string[] = []

    // Reasoning is activity metadata, not answer prose. Keep it in the same
    // first-class collapsible item used by Codex instead of synthetic Markdown.
    let thinking = ""

    const proc = runProcess({
      command: bin,
      args,
      cwd: state.cwd,
      env: opts?.env,
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
        if (sid && sid !== state.claudeSessionId) {
          state.claudeSessionId = sid
          cb.onAgentSession?.(sessionId, sid)
        }

        if (type === "system" && ev.subtype === "init") {
          if (
            typeof ev.session_id === "string" &&
            ev.session_id !== state.claudeSessionId
          ) {
            state.claudeSessionId = ev.session_id
            cb.onAgentSession?.(sessionId, ev.session_id)
          }
          return
        }

        // Partial tokens
        if (
          type === "stream_event" ||
          type === "content_block_delta" ||
          (ev.event && typeof ev.event === "object")
        ) {
          const inner = ev.event as Record<string, unknown> | undefined
          if (inner?.type === "message_start") {
            beginSnapshotMessage(snap, messageIdOf(inner.message))
          }
          const think = extractThinkingDelta(ev)
          if (think) {
            if (!turn) turn = beginAssistant(sessionId, cb)
            thinking += think
            cb.onTurnItem(sessionId, turn.messageId, {
              id: "claude-reasoning",
              kind: "reasoning",
              status: "running",
              summary: thinking,
            })
            return
          }
          const delta = extractPartialDelta(ev)
          if (delta) {
            if (!turn) turn = beginAssistant(sessionId, cb)
            pushDelta(turn, sessionId, delta, cb)
            noteSnapshotDelta(snap, delta)
            sawText = true
          }
          return
        }

        if (type === "assistant") {
          const msg = ev.message as Record<string, unknown> | undefined
          const text = extractTextFromContent(msg?.content ?? ev.content)
          if (text) {
            // Full snapshot of ONE assistant message: append whatever its own
            // deltas could not carry (tool cards, and the text if partials are off).
            const extra = snapshotDelta(snap, messageIdOf(msg), text)
            if (extra) {
              if (!turn) turn = beginAssistant(sessionId, cb)
              pushDelta(turn, sessionId, extra, cb)
            }
            sawText = true
          }
          return
        }

        if (type === "result") {
          // The result envelope is the only line that totals the whole turn —
          // the per-message `usage` blocks above would double-count on resume.
          usage = readUsage(ev) ?? usage
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
      onSpawnError: (err) => {
        // ENOENT/EACCES never reach stderr — without this the turn dies silent.
        stderr.push(err.message)
      },
      onExit: (code) => {
        if (thinking && turn) {
          cb.onTurnItem(sessionId, turn.messageId, {
            id: "claude-reasoning",
            kind: "reasoning",
            status: code === 0 ? "completed" : "interrupted",
            summary: thinking,
          })
        }
        const messageId = turn?.messageId
        finishTurn(turn, sessionId, cb)
        turn = null
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
          // aborted
          cb.onSessionEvent({
            type: "session.status",
            id: sessionId,
            status: "idle",
          })
        } else {
          // Always say something: a silent red dot is indistinguishable from a
          // hung session, and a spawn failure writes nothing to stderr.
          if (!sawText) {
            const errTail = stderr.slice(-8).join("\n") || "(no stderr output)"
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

function messageIdOf(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined
  const id = (msg as { id?: unknown }).id
  return typeof id === "string" ? id : undefined
}

function extractThinkingDelta(ev: Record<string, unknown>): string {
  // Reasoning arrives as `thinking_delta` blocks carrying a `thinking` string,
  // nested one or two levels deep depending on the claude version.
  const pick = (d: unknown): string => {
    if (!d || typeof d !== "object") return ""
    const o = d as Record<string, unknown>
    return typeof o.thinking === "string" ? o.thinking : ""
  }
  const direct = pick(ev.delta)
  if (direct) return direct
  const event = ev.event as Record<string, unknown> | undefined
  if (event) {
    const nested = pick(event.delta)
    if (nested) return nested
    if (typeof event.thinking === "string") return event.thinking
  }
  return ""
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
