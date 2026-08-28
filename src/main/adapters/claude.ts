import { findBinary, isExecutable } from "./binary"
import { buildClaudeArgs } from "./args"
import { buildEditDiff } from "./edit-diff"
import {
  appendInteractiveInputInstruction,
  formatInteractiveAnswer,
  InteractiveQuestionStream,
  type InteractiveQuestion,
} from "./interactive-input"
import { runProcess, type RunningProcess } from "./process-runner"
import { randomUUID } from "node:crypto"
import {
  beginAssistant,
  emitTurnItem,
  beginSnapshotMessage,
  clipOutput,
  finishTurn,
  newSnapshot,
  noteSnapshotDelta,
  pushDelta,
  safeJson,
  snapshotDelta,
  structuredPatchToDiff,
  toolResultText,
  type SnapshotState,
  type StreamTurn,
} from "./stream-parse"
import { readUsage } from "./usage"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import {
  isPlanToolName,
  planStepsFromInput,
  splitToolName,
  summarizeToolArgs,
} from "@shared/tool-card"
import type {
  AgentTurnItem,
  TurnFileChange,
  TurnItemStatus,
  TurnPlanStep,
  TurnSubagentStep,
  TurnUsage,
} from "@shared/types"
import type {
  AdapterCallbacks,
  AdapterSendOpts,
  AdapterStartOpts,
  AgentAdapter,
} from "./types"
import { asText } from "@shared/text"

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
      waitingForInput?: boolean
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
      systemPrompt: appendInteractiveInputInstruction(opts?.systemPrompt),
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
    const activity = new ClaudeActivityStream(state.cwd)
    const stderr: string[] = []

    const questionStream = new InteractiveQuestionStream()
    let continuation: Promise<void> | null = null
    const pushAssistantText = (text: string) => {
      const visible = questionStream.push(text)
      if (!visible) return
      if (!turn) turn = beginAssistant(sessionId, cb)
      pushDelta(turn, sessionId, visible, cb)
      sawText = true
    }
    const publish = (emitted: ClaudeEmit) => {
      if (emitted.items.length > 0) {
        if (!turn) turn = beginAssistant(sessionId, cb)
        for (const item of emitted.items) {
          emitTurnItem(turn, sessionId, item, cb)
        }
      }
      if (emitted.text) pushAssistantText(emitted.text)
    }

    const proc = runProcess({
      command: bin,
      args,
      cwd: state.cwd,
      env: opts?.env,
      onStdoutLine: (line) => {
        const ev = safeJson(line)
        if (!ev) {
          pushAssistantText(line + "\n")
          return
        }

        const sid = claudeSessionIdOf(ev)
        if (sid && sid !== state.claudeSessionId) {
          state.claudeSessionId = sid
          cb.onAgentSession?.(sessionId, sid)
        }

        if (asText(ev.type) === "result") {
          // One `result` per internal turn, and an async subagent makes several
          // in one run: the token counts add up, the cost is already a total.
          usage = mergeClaudeUsage(usage, readUsage(ev))
          publish(activity.push(ev))
          // Final envelope; the text is normally already streamed.
          if (!turn && typeof ev.result === "string") pushAssistantText(ev.result)
          return
        }

        publish(activity.push(ev))
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
        const completedQuestion = questionStream.finish()
        if (completedQuestion.visible) {
          if (!turn) turn = beginAssistant(sessionId, cb)
          pushDelta(turn, sessionId, completedQuestion.visible, cb)
          sawText = true
        }
        const outcome = code === 0 ? "completed" : "interrupted"
        const messageId = turn?.messageId
        finishTurn(turn, sessionId, cb, outcome)
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
          if (completedQuestion.question && cb.onUserInputRequest) {
            continuation = this.continueAfterQuestion(
              sessionId,
              completedQuestion.question,
              cb,
              opts,
            )
          }
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
      requestId: `claude-input-${randomUUID()}`,
      sessionId,
      source: "claude",
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

/** What one stream line turned into: cards to publish, prose for the bubble. */
export type ClaudeEmit = {
  items: AgentTurnItem[]
  text: string
}

type ClaudeCall = {
  itemId: string
  name: string
  input: Record<string, unknown>
  /** Built once, while the file on disk is still the version being edited. */
  changes?: TurnFileChange[]
}

/** The kinds one tool call can turn into — never `error`, which has a fixed status. */
type ClaudeCallItem = Extract<
  AgentTurnItem,
  { kind: "command" | "file_change" | "web_search" | "tool" | "plan" }
>

type SubagentState = {
  itemId: string
  name: string
  description?: string
  steps: TurnSubagentStep[]
  status: TurnItemStatus
  result?: string
  tokens?: number
  toolUses?: number
  durationMs?: number
  /** Child tool_use id → its step, so the child's own result settles it. */
  stepOf: Map<string, TurnSubagentStep>
}

// Claude Code 2.1 spells the spawn tool `Agent` in the stream and `Task` in the
// tool list; a call by any other name still gets a card once its child speaks.
const SUBAGENT_TOOLS = new Set(["task", "agent"])
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"])
const SEARCH_TOOLS = new Set(["websearch", "webfetch", "web_search", "web_fetch"])

/**
 * Claude Code's stream-json, turned into the transcript's own vocabulary.
 *
 * Two things about the real stream drive the whole shape of this class. Every
 * line carries `parent_tool_use_id`, and a non-null one means the line belongs
 * to a *spawned agent*, not to the turn the user is reading — merging those in
 * puts a child's prose, its thinking and its tool cards into the parent's
 * bubble. And a tool's outcome never rides with its call: it arrives one or
 * more lines later inside a `user` envelope keyed by `tool_use_id`, with the
 * structured payload (`structuredPatch`, `stdout`, image bytes) alongside it.
 */
export class ClaudeActivityStream {
  private readonly calls = new Map<string, ClaudeCall>()
  private readonly agents = new Map<string, SubagentState>()
  /** Subagent by the CLI's task id, which only the `task_*` lines carry. */
  private readonly agentsByTask = new Map<string, SubagentState>()
  private readonly snap: SnapshotState = newSnapshot()
  private readonly reasoning = new Map<string, string>()
  private messageCount = 0
  private reasoningId: string | null = null
  private plan: TurnPlanStep[] = []
  private compacting = false
  /** Last two characters of the prose so far — enough to know if it broke. */
  private tail = ""
  private pendingBreak = false

  constructor(private readonly cwd?: string) {}

  push(ev: Record<string, unknown>): ClaudeEmit {
    switch (asText(ev.type)) {
      case "system":
        return this.system(ev)
      case "stream_event":
      case "content_block_delta":
        return this.streamEvent(ev)
      case "assistant":
        return this.assistant(ev)
      case "user":
        return this.user(ev)
      case "result":
        return this.result(ev)
      case "rate_limit_event":
        return this.rateLimit(ev)
      default:
        // An `event` payload with no envelope type is still a partial message.
        return record(ev.event) ? this.streamEvent(ev) : none()
    }
  }

  private system(ev: Record<string, unknown>): ClaudeEmit {
    switch (asText(ev.subtype)) {
      case "status":
        // The CLI says "compacting" long before the boundary lands; opening the
        // card here is the difference between a visible wait and a dead turn.
        if (str(ev.status) === "compacting" && !this.compacting) {
          this.compacting = true
          return one({ id: "claude-compaction", kind: "compaction", status: "running" })
        }
        return none()
      case "compact_boundary":
      case "microcompact_boundary":
        return one(this.compaction(record(ev.compact_metadata)))
      case "task_started":
        return this.taskStarted(ev)
      case "task_progress":
        return this.taskProgress(ev)
      case "task_updated":
        return this.taskUpdated(ev)
      case "task_notification":
        return this.taskFinished(ev)
      case "hook_response":
        return this.hook(ev)
      case "post_turn_summary":
        return this.postTurnSummary(ev)
      default:
        return none()
    }
  }

  private compaction(meta: Record<string, unknown> | null): AgentTurnItem {
    this.compacting = false
    const item: AgentTurnItem = {
      id: "claude-compaction",
      kind: "compaction",
      status: "completed",
    }
    if (!meta) return item
    const trigger = str(meta.trigger)
    const pre = num(meta.pre_tokens)
    const post = num(meta.post_tokens)
    return {
      ...item,
      ...(trigger ? { trigger } : {}),
      ...(pre === undefined ? {} : { preTokens: pre }),
      ...(post === undefined ? {} : { postTokens: post }),
    }
  }

  /**
   * A hook that succeeded said nothing worth a card; one that blocked or failed
   * is the reason a turn stopped doing what it was asked to.
   */
  private hook(ev: Record<string, unknown>): ClaudeEmit {
    const outcome = str(ev.outcome) ?? ""
    const exit = num(ev.exit_code) ?? 0
    if (outcome === "success" && exit === 0) return none()
    const name = str(ev.hook_name) ?? str(ev.hook_event) ?? "hook"
    const detail =
      str(ev.stderr)?.trim() || str(ev.output)?.trim() || str(ev.stdout)?.trim()
    return one({
      id: `claude-hook-${str(ev.hook_id) ?? name}`,
      kind: "error",
      status: "failed",
      message: `${name} hook ${outcome || "failed"}${exit ? ` (exit ${String(exit)})` : ""}${
        detail ? `: ${detail}` : ""
      }`,
    })
  }

  /** The CLI's own closing line, kept only when it says the turn needs a human. */
  private postTurnSummary(ev: Record<string, unknown>): ClaudeEmit {
    const needs = str(ev.needs_action)?.trim()
    if (!needs) return none()
    const detail = str(ev.status_detail)?.trim()
    return one({
      id: "claude-needs-action",
      kind: "review",
      status: "completed",
      text: detail ? `${detail} — ${needs}` : needs,
    })
  }

  private taskStarted(ev: Record<string, unknown>): ClaudeEmit {
    const callId = str(ev.tool_use_id)
    const taskId = str(ev.task_id)
    const agent = this.agentFor(callId, taskId, str(ev.subagent_type))
    if (!agent) return none()
    if (taskId) this.agentsByTask.set(taskId, agent)
    agent.description = str(ev.description) ?? agent.description
    agent.status = "running"
    return one(subagentItem(agent))
  }

  private taskProgress(ev: Record<string, unknown>): ClaudeEmit {
    const agent = this.agentFor(str(ev.tool_use_id), str(ev.task_id), str(ev.subagent_type))
    if (!agent) return none()
    // `last_tool_name` plus the CLI's re-worded description is the closest thing
    // to a live caption for a child whose own events may never be replayed.
    const label = str(ev.last_tool_name) ?? "Working"
    const detail = str(ev.description)
    const last = agent.steps[agent.steps.length - 1]
    if (last && last.label === label && last.status === "running") {
      if (detail) last.detail = detail
    } else {
      settleSteps(agent.steps)
      agent.steps.push({ label, status: "running", ...(detail ? { detail } : {}) })
    }
    this.readAgentUsage(agent, record(ev.usage))
    agent.status = "running"
    return one(subagentItem(agent))
  }

  private taskUpdated(ev: Record<string, unknown>): ClaudeEmit {
    const agent = this.agentsByTask.get(str(ev.task_id) ?? "")
    const patch = record(ev.patch)
    if (!agent || !patch) return none()
    const status = str(patch.status)
    if (!status) return none()
    agent.status = taskStatus(status)
    if (agent.status !== "running") settleSteps(agent.steps, agent.status)
    return one(subagentItem(agent))
  }

  private taskFinished(ev: Record<string, unknown>): ClaudeEmit {
    const agent = this.agentFor(str(ev.tool_use_id), str(ev.task_id), undefined)
    if (!agent) return none()
    agent.status = taskStatus(str(ev.status) ?? "completed")
    agent.result = clipOutput(str(ev.summary) ?? agent.result)
    this.readAgentUsage(agent, record(ev.usage))
    settleSteps(agent.steps, agent.status)
    return one(subagentItem(agent))
  }

  private readAgentUsage(agent: SubagentState, usage: Record<string, unknown> | null): void {
    if (!usage) return
    agent.tokens = num(usage.total_tokens) ?? agent.tokens
    agent.toolUses = num(usage.tool_uses) ?? agent.toolUses
    agent.durationMs = num(usage.duration_ms) ?? agent.durationMs
  }

  private agentFor(
    callId: string | undefined,
    taskId: string | undefined,
    type: string | undefined,
  ): SubagentState | null {
    const existing =
      (callId ? this.agents.get(callId) : undefined) ??
      (taskId ? this.agentsByTask.get(taskId) : undefined)
    if (existing) {
      if (type) existing.name = type
      return existing
    }
    const key = callId ?? taskId
    if (!key) return null
    const agent: SubagentState = {
      itemId: `claude-agent-${key}`,
      name: type ?? "Agent",
      steps: [],
      status: "running",
      stepOf: new Map(),
    }
    if (callId) this.agents.set(callId, agent)
    if (taskId) this.agentsByTask.set(taskId, agent)
    return agent
  }

  private streamEvent(ev: Record<string, unknown>): ClaudeEmit {
    // A child agent's partial messages are not this turn's prose.
    if (str(ev.parent_tool_use_id)) return none()
    const inner = record(ev.event) ?? ev
    const type = asText(inner.type)

    if (type === "message_start") {
      // Reasoning is per assistant message: one merged blob across a long turn
      // reads as fragments of unrelated thoughts glued together.
      this.messageCount += 1
      this.reasoningId = this.thinkId(inner.message)
      this.pendingBreak = this.tail.length > 0
      beginSnapshotMessage(this.snap, messageIdOf(inner.message))
      return none()
    }

    if (type === "content_block_start") {
      const block = record(inner.content_block)
      if (block?.type !== "tool_use") return none()
      // The card exists the moment the call starts, not when its arguments have
      // finished streaming — that gap is minutes on a big Write.
      const item = this.toolCall(str(block.id), str(block.name) ?? "Tool", {})
      return item ? one(item) : none()
    }

    const delta = record(inner.delta)
    if (delta) {
      const thinking = str(delta.thinking)
      if (thinking) return one(this.think(thinking))
      const text = str(delta.text)
      if (text) {
        noteSnapshotDelta(this.snap, text)
        return { items: [], text: this.prose(text) }
      }
      return none()
    }
    return none()
  }

  /**
   * Two assistant messages in one turn are two paragraphs. Run together they
   * read as one sentence that changes its mind mid-word.
   */
  private prose(text: string): string {
    if (!text) return ""
    const lead = this.pendingBreak && !this.tail.endsWith("\n\n") ? "\n\n" : ""
    this.pendingBreak = false
    const out = lead + text
    this.tail = (this.tail + out).slice(-2)
    return out
  }

  /** Thinking belongs to the message that produced it, so its id is the key. */
  private thinkId(msg: unknown): string {
    const id = messageIdOf(msg)
    return `claude-think-${id ?? String(this.messageCount)}`
  }

  private think(chunk: string): AgentTurnItem {
    this.reasoningId ??= `claude-think-${String(this.messageCount)}`
    const summary = (this.reasoning.get(this.reasoningId) ?? "") + chunk
    this.reasoning.set(this.reasoningId, summary)
    return { id: this.reasoningId, kind: "reasoning", status: "running", summary }
  }

  private assistant(ev: Record<string, unknown>): ClaudeEmit {
    const msg = record(ev.message)
    const blocks = Array.isArray(msg?.content) ? msg.content : []
    const parent = str(ev.parent_tool_use_id)
    if (parent) return this.childAssistant(ev, parent, blocks)

    const items: AgentTurnItem[] = []
    let prose = ""
    for (const raw of blocks) {
      const block = record(raw)
      if (!block) continue
      if (block.type === "text") prose += str(block.text) ?? ""
      if (block.type === "thinking") {
        // Partials already carried it; without them this is the only copy.
        const full = str(block.thinking)
        const id = this.thinkId(msg)
        if (full && full.length > (this.reasoning.get(id)?.length ?? 0)) {
          this.reasoningId = id
          this.reasoning.set(id, full)
          items.push({ id, kind: "reasoning", status: "running", summary: full })
        }
      }
      if (block.type === "tool_use") {
        const item = this.toolCall(str(block.id), str(block.name) ?? "Tool", block.input)
        if (item) items.push(item)
      }
      if (block.type === "server_tool_use") {
        const item = this.toolCall(str(block.id), str(block.name) ?? "web_search", block.input)
        if (item) items.push(item)
      }
      if (
        block.type === "web_search_tool_result" ||
        block.type === "web_fetch_tool_result"
      ) {
        // A server-side search answers itself inside the assistant message —
        // there is no `user` envelope to settle its card the usual way.
        const call = this.calls.get(str(block.tool_use_id) ?? "")
        const failed = asText(record(block.content)?.type).endsWith("_error")
        const item = call ? this.itemFor(call, failed ? "failed" : "completed") : null
        if (item) items.push(item)
      }
    }
    // Whatever this one message's own deltas could not carry — all of it when
    // partial messages are switched off.
    const rest = prose ? snapshotDelta(this.snap, messageIdOf(msg), prose) : ""
    return { items, text: this.prose(rest) }
  }

  /**
   * A spawned agent's messages ride the same stream as the parent's, tagged
   * with the call that spawned them. They belong to that call's card.
   */
  private childAssistant(
    ev: Record<string, unknown>,
    parent: string,
    blocks: unknown[],
  ): ClaudeEmit {
    const agent = this.agentFor(parent, undefined, str(ev.subagent_type))
    if (!agent) return none()
    agent.description ??= str(ev.task_description)
    let touched = false
    for (const raw of blocks) {
      const block = record(raw)
      if (!block) continue
      if (block.type === "text") {
        const text = str(block.text)?.trim()
        if (text) {
          agent.result = clipOutput(text)
          touched = true
        }
      }
      if (block.type !== "tool_use") continue
      settleSteps(agent.steps)
      const { label } = splitToolName(str(block.name) ?? "Tool")
      const step: TurnSubagentStep = { label, status: "running" }
      const detail = summarizeToolArgs(block.input)
      if (detail) step.detail = detail
      agent.steps.push(step)
      const id = str(block.id)
      if (id) agent.stepOf.set(id, step)
      touched = true
    }
    return touched ? one(subagentItem(agent)) : none()
  }

  private user(ev: Record<string, unknown>): ClaudeEmit {
    const msg = record(ev.message)
    const blocks = Array.isArray(msg?.content) ? msg.content : []
    const results = blocks
      .map((raw) => record(raw))
      .filter((b): b is Record<string, unknown> => b?.type === "tool_result")
    if (results.length === 0) return none()

    const parent = str(ev.parent_tool_use_id)
    if (parent) {
      const agent = this.agents.get(parent)
      if (!agent) return none()
      for (const block of results) {
        const step = agent.stepOf.get(str(block.tool_use_id) ?? "")
        if (step) step.status = block.is_error === true ? "failed" : "completed"
      }
      return one(subagentItem(agent))
    }

    // The structured payload pairs with a lone result; two results in one
    // envelope would make it ambiguous which of them it describes.
    const structured = results.length === 1 ? ev.tool_use_result : undefined
    const items: AgentTurnItem[] = []
    for (const block of results) {
      const item = this.toolResult(block, structured)
      if (item) items.push(item)
    }
    return { items, text: "" }
  }

  private result(ev: Record<string, unknown>): ClaudeEmit {
    const items: AgentTurnItem[] = []
    for (const raw of asArray(ev.permission_denials)) {
      const denial = record(raw)
      if (!denial) continue
      const item = this.denied(denial)
      if (item) items.push(item)
    }
    const subtype = asText(ev.subtype)
    if (ev.is_error === true || subtype.startsWith("error")) {
      const errors = asArray(ev.errors)
        .filter((e): e is string => typeof e === "string")
        .join("\n")
      items.push({
        id: `claude-error-${str(ev.uuid) ?? subtype}`,
        kind: "error",
        status: "failed",
        message:
          errors ||
          str(ev.result) ||
          str(ev.api_error_status) ||
          `Claude ended the turn with ${subtype || "an error"}.`,
      })
    } else if (str(ev.stop_reason) === "refusal") {
      items.push({
        id: `claude-refusal-${str(ev.uuid) ?? "turn"}`,
        kind: "error",
        status: "failed",
        message: "Claude declined to continue this turn.",
      })
    }
    return { items, text: "" }
  }

  /** A tool the CLI asked for and was refused — the call, not the app, failed. */
  private denied(denial: Record<string, unknown>): AgentTurnItem | null {
    const id = str(denial.tool_use_id)
    const known = id ? this.calls.get(id) : undefined
    const name = str(denial.tool_name) ?? known?.name ?? "Tool"
    if (known) {
      const item = this.itemFor(known, "declined")
      if (item) return item
    }
    const { label, server } = splitToolName(name)
    return {
      id: `claude-denied-${id ?? label}`,
      kind: "tool",
      status: "declined",
      name: label,
      ...(server ? { server } : {}),
      arguments: denial.tool_input,
    }
  }

  private rateLimit(ev: Record<string, unknown>): ClaudeEmit {
    const info = record(ev.rate_limit_info)
    const status = str(info?.status)
    if (!info || !status || status === "allowed") return none()
    const resets = num(info.resetsAt)
    return one({
      id: "claude-rate-limit",
      kind: "error",
      status: "failed",
      message: `Rate limited (${str(info.rateLimitType) ?? status})${
        resets
          ? ` — resets ${new Date(resets * 1000).toLocaleTimeString("en-US")}`
          : ""
      }`,
    })
  }

  /** One tool_use block → the card that stands for it for the rest of the turn. */
  private toolCall(
    id: string | undefined,
    name: string,
    input: unknown,
  ): AgentTurnItem | null {
    const key = id ?? `${name}-${String(this.calls.size)}`
    const args = record(input) ?? {}
    const previous = this.calls.get(key)
    // content_block_start names the call before its arguments exist; the
    // snapshot that follows carries them and must not blank the card.
    const merged = Object.keys(args).length > 0 ? args : (previous?.input ?? {})
    const call: ClaudeCall = { itemId: "", name, input: merged }
    call.itemId = itemIdFor(key, name)
    this.calls.set(key, call)
    if (isSubagentTool(name)) {
      const agent = this.agentFor(key, undefined, str(merged.subagent_type))
      if (!agent) return null
      agent.description ??= str(merged.description) ?? str(merged.prompt)
      return subagentItem(agent)
    }
    return this.itemFor(call, "running")
  }

  private itemFor(call: ClaudeCall, status: TurnItemStatus): ClaudeCallItem | null {
    const { itemId, name, input } = call
    const lower = name.toLowerCase()

    if (isPlanToolName(name)) {
      const steps = planStepsFromInput(input)
      if (steps.length > 0) {
        this.plan = steps.map((step) => ({
          text: step.text,
          status: step.status === "in_progress" ? "running" : step.status,
          ...(step.id ? { id: step.id } : {}),
        }))
      }
      if (this.plan.length === 0) return null
      const active =
        this.plan.find((step) => step.status === "running") ??
        this.plan.find((step) => step.status === "pending")
      return {
        id: "claude-plan",
        kind: "plan",
        status: active ? "running" : "completed",
        text: active?.text ?? `${String(this.plan.length)} steps`,
        steps: this.plan,
      }
    }

    if (lower === "bash" || lower === "bashoutput") {
      return {
        id: itemId,
        kind: "command",
        status,
        command: str(input.command) ?? name,
        ...(this.cwd ? { cwd: this.cwd } : {}),
      }
    }

    if (EDIT_TOOLS.has(lower)) {
      // The diff is derived from the file as it was BEFORE the write; asking
      // again once the result lands would read back the edited version. An
      // opening block has no arguments yet, so nothing is cached until it does.
      const changes = call.changes ?? editChanges(input, lower)
      if (changes.length > 0) call.changes = changes
      return { id: itemId, kind: "file_change", status, changes }
    }

    if (SEARCH_TOOLS.has(lower)) {
      return {
        id: itemId,
        kind: "web_search",
        status,
        query: str(input.query) ?? str(input.url) ?? name,
      }
    }

    const { label, server } = splitToolName(name)
    return {
      id: itemId,
      kind: "tool",
      status,
      name: label,
      ...(server ? { server } : {}),
      ...(Object.keys(input).length > 0 ? { arguments: input } : {}),
    }
  }

  /** Pair an outcome back onto the card its call opened. */
  private toolResult(
    block: Record<string, unknown>,
    structured: unknown,
  ): AgentTurnItem | null {
    const id = str(block.tool_use_id)
    const call = id ? this.calls.get(id) : undefined
    if (!call) return null
    if (isSubagentTool(call.name)) {
      // The Task result is launch bookkeeping the CLI marks as internal — the
      // child's own report arrives as task_notification.
      const agent = id ? this.agents.get(id) : undefined
      return agent ? subagentItem(agent) : null
    }

    const failed = block.is_error === true
    const status: TurnItemStatus = failed ? "failed" : "completed"
    const payload = record(structured)
    const text = toolResultText(block.content)
    const item = this.itemFor(call, status)
    if (!item) return null

    if (item.kind === "command") {
      const exit = exitCodeOf(text, payload)
      const output = payload
        ? [str(payload.stdout), str(payload.stderr)].filter(Boolean).join("\n")
        : ""
      return {
        ...item,
        status: failed || (exit !== undefined && exit !== 0) ? "failed" : status,
        ...(exit === undefined ? {} : { exitCode: exit }),
        ...(clipOutput(output || text) ? { output: clipOutput(output || text) } : {}),
      }
    }

    if (item.kind === "file_change") {
      // The CLI already applied the edit, so its own patch is the only source
      // with honest line numbers.
      const patch = structuredPatchToDiff(payload?.structuredPatch)
      if (!patch) return { ...item, status }
      const changes = item.changes.map((change, at) =>
        at === 0 ? { ...change, diff: patch.text } : change,
      )
      return { ...item, status, changes }
    }

    const image = imageResult(block.content, payload)
    if (image) {
      return {
        id: item.id,
        kind: "image",
        status,
        path: str(call.input.file_path) ?? str(call.input.path) ?? image,
      }
    }

    if (item.kind === "tool") {
      return {
        ...item,
        status,
        ...(failed ? { error: clipOutput(text) } : { result: clipOutput(text) }),
      }
    }
    return { ...item, status }
  }
}

function itemIdFor(key: string, name: string): string {
  return `claude-${name.toLowerCase()}-${key}`
}

function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOLS.has(name.toLowerCase().replace(/[\s_-]+/g, ""))
}

function subagentItem(agent: SubagentState): AgentTurnItem {
  return {
    id: agent.itemId,
    kind: "subagent",
    status: agent.status,
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.steps.length > 0 ? { steps: agent.steps.map((step) => ({ ...step })) } : {}),
    ...(agent.result ? { result: agent.result } : {}),
    ...(agent.tokens === undefined ? {} : { tokens: agent.tokens }),
    ...(agent.toolUses === undefined ? {} : { toolUses: agent.toolUses }),
    ...(agent.durationMs === undefined ? {} : { durationMs: agent.durationMs }),
  }
}

/** A child only ever runs one thing at a time; the previous step is over. */
function settleSteps(steps: TurnSubagentStep[], outcome: TurnItemStatus = "completed"): void {
  for (const step of steps) {
    if (step.status === "running" || step.status === "pending") step.status = outcome
  }
}

function taskStatus(raw: string): TurnItemStatus {
  switch (raw.toLowerCase()) {
    case "completed":
    case "success":
      return "completed"
    case "failed":
    case "error":
      return "failed"
    case "cancelled":
    case "canceled":
    case "interrupted":
      return "interrupted"
    default:
      return "running"
  }
}

function editChanges(input: Record<string, unknown>, lower: string): TurnFileChange[] {
  const file = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path)
  // The call's arguments stream in after its block opens; a card with no file
  // yet says "Edit", not "Edit · (nothing)".
  if (!file) return []
  const pairs: { oldText: string; newText: string }[] = []
  if (lower === "write") {
    pairs.push({ oldText: "", newText: str(input.content) ?? "" })
  } else if (lower === "multiedit" && Array.isArray(input.edits)) {
    for (const raw of input.edits) {
      const edit = record(raw)
      if (!edit) continue
      pairs.push({ oldText: str(edit.old_string) ?? "", newText: str(edit.new_string) ?? "" })
    }
  } else {
    pairs.push({ oldText: str(input.old_string) ?? "", newText: str(input.new_string) ?? "" })
  }
  const diff = buildEditDiff(file, pairs).text
  const kind = lower === "write" ? "add" : "edit"
  return [{ path: file, kind, ...(diff ? { diff } : {}) }]
}

/** Bash prints its status as the first line of a failed result, not as a field. */
function exitCodeOf(
  text: string,
  payload: Record<string, unknown> | null,
): number | undefined {
  const reported = num(payload?.exitCode) ?? num(payload?.exit_code)
  if (reported !== undefined) return reported
  const match = /^(?:Error: )?Exit code (\d+)/m.exec(text)
  return match ? Number(match[1]) : undefined
}

/** The base64 the agent looked at never reaches state.json — only that it did. */
function imageResult(content: unknown, payload: Record<string, unknown> | null): string | null {
  if (payload?.type === "image") return "image"
  if (!Array.isArray(content)) return null
  for (const raw of content) {
    const block = record(raw)
    if (block?.type === "image") return "image"
  }
  return null
}

function claudeSessionIdOf(ev: Record<string, unknown>): string | undefined {
  return str(ev.session_id) ?? str(record(ev.message)?.session_id)
}

/**
 * Claude prints one `result` per internal turn — a turn that spawns an async
 * subagent prints several. Token counts are per result and add up; the cost is
 * already the run's running total.
 */
export function mergeClaudeUsage(
  prev: TurnUsage | null,
  next: TurnUsage | null,
): TurnUsage | null {
  if (!next) return prev
  if (!prev) return next
  const merged: TurnUsage = { ...prev }
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreateTokens",
    "durationMs",
  ] as const) {
    if (next[key] === undefined) continue
    merged[key] = (prev[key] ?? 0) + next[key]
  }
  if (next.costUsd !== undefined) merged.costUsd = next.costUsd
  if (next.contextWindow !== undefined) merged.contextWindow = next.contextWindow
  return merged
}

function messageIdOf(msg: unknown): string | undefined {
  return str(record(msg)?.id)
}

function none(): ClaudeEmit {
  return { items: [], text: "" }
}

function one(item: AgentTurnItem | null): ClaudeEmit {
  return { items: item ? [item] : [], text: "" }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
