import type {
  ChatMessage,
  SessionMeta,
  SessionUsage,
  TurnUsage,
} from "@shared/types"
import { RESTART_CUT_TITLE } from "@shared/notices"
import { formatElapsed } from "./live-step"
import { formatUsd } from "./usage"

export type TurnOutcomeTone = "done" | "waiting" | "error" | "interrupted"

/**
 * One line that says what the chat is doing now that nobody is streaming:
 * finished and idle, waiting on the reader, cut short, or failed. The live
 * ticker covers the running case; this is its counterpart for rest.
 */
export type TurnOutcome = {
  tone: TurnOutcomeTone
  /** Short state word, e.g. "Turn finished". */
  label: string
  /** Facts about the last turn, already formatted: steps, time, cost. */
  facts: string[]
  /** What the reader can do next. */
  hint: string
  /** The message to scroll to, when there is one. */
  messageId: string | null
}

function lastAssistant(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === "assistant") return message
  }
  return null
}

function stepFacts(message: ChatMessage | null): string[] {
  const items = message?.items ?? []
  const steps = items.filter((item) => item.kind !== "notice" && item.kind !== "reasoning")
  if (steps.length === 0) return []
  const failed = steps.filter((item) => item.status === "failed").length
  const facts = [`${steps.length} ${steps.length === 1 ? "step" : "steps"}`]
  if (failed > 0) facts.push(`${failed} failed`)
  return facts
}

function usageFacts(last: TurnUsage | undefined): string[] {
  if (!last) return []
  const facts: string[] = []
  if (last.durationMs !== undefined && last.durationMs > 0) {
    facts.push(formatElapsed(last.durationMs))
  }
  if (last.costUsd !== undefined && last.costUsd > 0) facts.push(formatUsd(last.costUsd))
  return facts
}

function cutByRestart(message: ChatMessage | null): boolean {
  return (message?.items ?? []).some(
    (item) => item.kind === "notice" && item.title === RESTART_CUT_TITLE,
  )
}

export function turnOutcome(
  session: Pick<SessionMeta, "status">,
  messages: readonly ChatMessage[],
  usage: SessionUsage | null,
): TurnOutcome | null {
  if (session.status === "running") return null
  const last = lastAssistant(messages)
  if (!last) return null
  const messageId = last.id
  if (session.status === "waiting_input") {
    return {
      tone: "waiting",
      label: "Waiting for your answer",
      facts: [],
      hint: "the agent asked a question above",
      messageId,
    }
  }
  if (cutByRestart(last)) {
    return {
      tone: "interrupted",
      label: "Interrupted by a restart",
      facts: stepFacts(last),
      hint: "send “continue” to pick the turn up",
      messageId,
    }
  }
  const facts = [...stepFacts(last), ...usageFacts(usage?.lastTurn)]
  if (session.status === "error") {
    return {
      tone: "error",
      label: "Turn ended with an error",
      facts,
      hint: "the transcript says why",
      messageId,
    }
  }
  return {
    tone: "done",
    label: "Turn finished",
    facts,
    hint: "ready for your next message · background commands it started keep running",
    messageId,
  }
}
