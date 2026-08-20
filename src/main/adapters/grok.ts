import { findBinary, isExecutable } from "./binary"
import { buildGrokArgs } from "./args"
import {
  appendInteractiveInputInstruction,
  formatInteractiveAnswer,
  InteractiveQuestionStream,
  type InteractiveQuestion,
} from "./interactive-input"
import { runProcess, type RunningProcess } from "./process-runner"
import { buildEditDiff } from "./edit-diff"
import { randomUUID } from "node:crypto"
import {
  beginAssistant,
  emitTurnItem,
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
import { renderCliFailure } from "./failure-message"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import { isPlanToolName, planStepsFromInput } from "@shared/tool-card"
import type {
  AgentTurnItem,
  TurnFileChange,
  TurnItemStatus,
  TurnPlanStep,
  TurnUsage,
} from "@shared/types"
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
      waitingForInput?: boolean
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
      systemPrompt: appendInteractiveInputInstruction(opts?.systemPrompt),
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
    const activity = new GrokActivityStream()
    const questionStream = new InteractiveQuestionStream()
    let continuation: Promise<void> | null = null
    const pushAssistantText = (text: string) => {
      const visible = questionStream.push(text)
      if (!visible) return
      if (!turn) turn = beginAssistant(sessionId, cb)
      pushDelta(turn, sessionId, visible, cb)
    }

    const proc = runProcess({
      command: bin,
      args,
      cwd: state.cwd,
      env: opts?.env,
      onStdoutLine: (line) => {
        const ev = safeJson(line)
        if (!ev) {
          if (line.trim()) {
            pushAssistantText(line + "\n")
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

        // Thought chunks stay out of the answer bubble, but the reasoning card
        // is where they belong — a placeholder there told the user nothing.
        if (type === "thought") {
          const item = activity.thought(String(ev.data ?? ""))
          if (!item) return
          if (!turn) turn = beginAssistant(sessionId, cb)
          emitTurnItem(turn, sessionId, item, cb)
          return
        }

        const action = activity.push(ev, type)
        if (action) {
          if (!turn) turn = beginAssistant(sessionId, cb)
          emitTurnItem(turn, sessionId, action, cb)
          return
        }

        const delta = extractGrokText(ev, type)

        if (delta) {
          pushAssistantText(delta)
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
            if (extra) pushAssistantText(extra)
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
        const completedQuestion = questionStream.finish()
        if (completedQuestion.visible) {
          if (!turn) turn = beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, completedQuestion.visible, cb)
        }
        const messageId = turn?.messageId
        const outcome: TurnItemStatus =
          code === 0 ? "completed" : code === null ? "interrupted" : "failed"
        if (usage) cb.onUsage?.(sessionId, usage, messageId)
        // A newer turn may already own this session (Stop then immediate
        // resend): a dead process must not overwrite the live turn's status.
        if (state.proc !== proc) {
          finishTurn(turn, sessionId, cb, outcome)
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
          if (completedQuestion.question && cb.onUserInputRequest) {
            continuation = this.continueAfterQuestion(
              sessionId,
              completedQuestion.question,
              cb,
              opts,
            )
          }
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
        finishTurn(turn, sessionId, cb, outcome)
      },
    })

    state.proc = proc
    await proc.done
    // eslint-disable-next-line @typescript-eslint/await-thenable -- assigned inside the onStdoutLine closure, which control-flow analysis can't see
    if (continuation) await continuation
  }

  async abort(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.aborting = true
    state.proc?.abort()
  }

  async dispose(sessionId: string): Promise<void> {
    await this.abort(sessionId)
    this.sessions.delete(sessionId)
  }

  private async continueAfterQuestion(
    sessionId: string,
    question: InteractiveQuestion,
    cb: AdapterCallbacks,
    opts: AdapterSendOpts | undefined,
  ): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || !cb.onUserInputRequest) return
    state.waitingForInput = true
    const answers = await cb.onUserInputRequest({
      requestId: `grok-input-${randomUUID()}`,
      sessionId,
      source: "grok",
      questions: question.questions,
    })
    state.waitingForInput = false
    if (state.aborting) {
      state.aborting = false
      return
    }
    const message = formatInteractiveAnswer(question, answers)
    cb.onMessage({
      id: randomUUID(),
      sessionId,
      role: "user",
      content: message,
      createdAt: Date.now(),
    })
    await this.send(sessionId, message, cb, { ...opts, attachments: undefined })
  }
}

const TOOL_TYPES = new Set([
  "tool",
  "tool_use",
  "tool_call",
  "tool_call_update",
  "tool_result",
  "function_call",
  "function_result",
  "command",
  "command_execution",
  "command_start",
  "command_end",
])

const OUTPUT_LIMIT = 8000

type GrokCall = {
  id: string
  name: string
  /** ACP tool kind — read | edit | execute | plan | search | fetch | other. */
  kind: string
  input?: Record<string, unknown>
  status: TurnItemStatus
  output?: string
  exitCode?: number
  cwd?: string
  changes?: TurnFileChange[]
}

/**
 * Grok Build streams ACP session updates: `tool_call` names the call and
 * carries its arguments, and every `tool_call_update` after it carries the id
 * plus only what changed — no name, no input, sometimes a null status. Reading
 * either event alone loses half the card, so the pair is merged here into one
 * item that keeps its name and reaches a settled status.
 */
export class GrokActivityStream {
  private readonly calls = new Map<string, GrokCall>()
  private lastCallId: string | null = null
  private planSteps: TurnPlanStep[] = []
  private reasoning = ""
  private reasoningOpen = false

  /** One raw thought chunk → the reasoning item, or null while it is empty. */
  thought(chunk: string): AgentTurnItem | null {
    if (!chunk) return null
    if (this.reasoning && !this.reasoningOpen) this.reasoning += "\n\n"
    this.reasoning += chunk
    this.reasoningOpen = true
    return {
      id: "grok-reasoning",
      kind: "reasoning",
      status: "running",
      summary: this.reasoning,
    }
  }

  push(
    ev: Record<string, unknown>,
    type = String(ev.type ?? ev.event ?? ""),
  ): AgentTurnItem | null {
    const lower = type.toLowerCase()
    if (lower !== "thought") this.reasoningOpen = false
    if (lower === "plan") return this.plan(ev.entries)
    if (!TOOL_TYPES.has(lower)) return null

    const id = this.callId(ev, lower)
    const call = mergeGrokCall(this.calls.get(id), ev, lower, id)
    this.calls.set(id, call)
    this.lastCallId = id
    // A checklist call and grok's own `plan` event describe the same list;
    // funnel both into one card rather than showing the plan twice.
    if (call.kind === "plan" || isPlanToolName(call.name)) {
      return this.plan(call.input?.todos ?? call.input?.plan ?? call.input)
    }
    return grokToolItem(call)
  }

  private plan(entries: unknown): AgentTurnItem | null {
    const steps = planStepsFromInput(Array.isArray(entries) ? { todos: entries } : entries)
    // Grok's merge-mode checklist repeats ids with no text; keeping the last
    // populated list is what stops the card blanking mid-turn.
    if (steps.length > 0) {
      this.planSteps = steps.map((step) => ({
        text: step.text,
        status: step.status === "in_progress" ? "running" : step.status,
        ...(step.id ? { id: step.id } : {}),
      }))
    }
    if (this.planSteps.length === 0) return null
    const active =
      this.planSteps.find((step) => step.status === "running") ??
      this.planSteps.find((step) => step.status === "pending")
    return {
      id: "grok-plan",
      kind: "plan",
      status: active ? "running" : "completed",
      text: active?.text ?? `${this.planSteps.length} steps`,
      steps: this.planSteps,
    }
  }

  private callId(ev: Record<string, unknown>, lower: string): string {
    const id =
      stringValue(ev.toolCallId) ??
      stringValue(ev.tool_call_id) ??
      stringValue(ev.call_id) ??
      stringValue(ev.id)
    if (id) return id
    // An update without an id can only belong to the call it follows; a first
    // event without one still needs an id of its own, not a shared placeholder.
    if (this.lastCallId) return this.lastCallId
    return `${lower}-${String(this.calls.size)}`
  }
}

/** Single-event view of the tool stream, for envelopes that carry it all. */
export function extractGrokAction(
  ev: Record<string, unknown>,
  type = String(ev.type ?? ev.event ?? ""),
): AgentTurnItem | null {
  return new GrokActivityStream().push(ev, type)
}

function mergeGrokCall(
  prev: GrokCall | undefined,
  ev: Record<string, unknown>,
  lower: string,
  id: string,
): GrokCall {
  const nested =
    objectValue(ev.tool) ?? objectValue(ev.call) ?? objectValue(ev.function) ?? {}
  const raw = objectValue(ev.rawOutput)
  const output = grokOutputText(ev)
  const changes = grokFileChanges(ev)
  return {
    id,
    name:
      stringValue(ev.toolName) ??
      stringValue(ev.tool_name) ??
      stringValue(ev.name) ??
      stringValue(ev.title) ??
      stringValue(nested.name) ??
      prev?.name ??
      "Tool",
    kind: stringValue(ev.kind) ?? prev?.kind ?? "",
    input:
      objectValue(ev.rawInput) ??
      objectValue(ev.input) ??
      objectValue(ev.arguments) ??
      objectValue(nested.input) ??
      objectValue(nested.arguments) ??
      prev?.input,
    status: grokStatus(ev, lower, prev),
    output: output ?? prev?.output,
    exitCode: numberValue(raw?.exit_code) ?? prev?.exitCode,
    cwd: stringValue(raw?.current_dir) ?? prev?.cwd,
    changes: changes ?? prev?.changes,
  }
}

function grokToolItem(call: GrokCall): AgentTurnItem {
  const id = `grok-${call.id}`
  const command = stringValue(call.input?.command) ?? stringValue(call.input?.cmd)
  if (call.kind === "execute" || command) {
    // Grok calls a command "completed" whatever it exited with; the exit code
    // is the only honest signal that the work itself failed.
    const failed =
      call.status === "completed" &&
      call.exitCode !== undefined &&
      call.exitCode !== 0
    return {
      id,
      kind: "command",
      status: failed ? "failed" : call.status,
      command: command ?? call.name,
      cwd: call.cwd,
      output: clipOutput(call.output),
      exitCode: call.exitCode,
    }
  }
  if (call.changes && call.changes.length > 0) {
    return { id, kind: "file_change", status: call.status, changes: call.changes }
  }
  return {
    id,
    kind: "tool",
    status: call.status,
    name: call.name,
    arguments: call.input,
    result: clipOutput(call.output),
  }
}

/**
 * An edit tool reports itself as ACP `diff` content blocks, not as output. The
 * hunk is rebuilt from the payload so a folder that is not a repo still gets a
 * real diff; the file on disk is already edited, so the line numbers are the
 * ones buildEditDiff can recover, not necessarily absolute.
 */
function grokFileChanges(ev: Record<string, unknown>): TurnFileChange[] | null {
  if (!Array.isArray(ev.content)) return null
  const changes: TurnFileChange[] = []
  for (const entry of ev.content) {
    const block = objectValue(entry)
    if (!block || block.type !== "diff") continue
    const path = stringValue(block.path)
    if (!path) continue
    const oldText = typeof block.oldText === "string" ? block.oldText : ""
    const newText = typeof block.newText === "string" ? block.newText : ""
    changes.push({
      path,
      kind: !oldText ? "add" : !newText ? "delete" : "edit",
      diff: buildEditDiff(path, [{ oldText, newText }]).text || undefined,
    })
  }
  return changes.length > 0 ? changes : null
}

function grokStatus(
  ev: Record<string, unknown>,
  lower: string,
  prev: GrokCall | undefined,
): TurnItemStatus {
  const raw = stringValue(ev.status)
  if (raw) {
    switch (raw.toLowerCase()) {
      case "completed":
      case "complete":
      case "success":
        return "completed"
      case "failed":
      case "error":
        return "failed"
      case "declined":
      case "rejected":
        return "declined"
      case "cancelled":
      case "canceled":
      case "interrupted":
        return "interrupted"
      // ACP opens a call as `pending` and flips to `in_progress` a beat later;
      // both read as one live state to somebody watching the card.
      default:
        return "running"
    }
  }
  // `tool_call_update` sends status:null when only the output changed.
  if (prev) return prev.status
  return lower.endsWith("result") || lower.endsWith("end") ? "completed" : "running"
}

/** Streamed tool output: ACP content blocks first, raw payload as a fallback. */
function grokOutputText(ev: Record<string, unknown>): string | null {
  const parts: string[] = []
  if (Array.isArray(ev.content)) {
    for (const entry of ev.content) {
      const block = objectValue(entry)
      const inner = (block && objectValue(block.content)) ?? block
      if (inner && typeof inner.text === "string") parts.push(inner.text)
    }
  }
  const joined = parts.join("")
  if (joined) return joined
  const raw = objectValue(ev.rawOutput)
  return (
    (raw && stringValue(raw.output_for_prompt)) ??
    stringValue(ev.output) ??
    stringValue(ev.result)
  )
}

function clipOutput(text: string | undefined): string | undefined {
  if (!text) return undefined
  return text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n… (${text.length - OUTPUT_LIMIT} more characters)`
    : text
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
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
