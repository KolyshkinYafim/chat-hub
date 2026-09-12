import type { ChatMessage, SessionMeta } from "@shared/types"
import { RESTART_CUT_TITLE } from "@shared/notices"
import {
  currentStep,
  itemStep,
  metaStep,
  stepPhaseLabel,
  type LiveStep,
} from "./live-step"
import { buildTranscript } from "./tool-runs"

function cutByRestart(messages: readonly ChatMessage[] | undefined): boolean {
  if (!messages) return false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== "assistant") continue
    return (message.items ?? []).some(
      (item) => item.kind === "notice" && item.title === RESTART_CUT_TITLE,
    )
  }
  return false
}

function runningStep(
  session: SessionMeta,
  messages: readonly ChatMessage[] | undefined,
): LiveStep | null {
  if (session.live) return metaStep(session.live)
  const last = messages?.[messages.length - 1]
  if (!last || last.role !== "assistant" || last.streaming !== true) {
    return {
      key: "connecting",
      kind: "starting",
      label: "Connecting",
      detail: null,
      server: null,
      phase: null,
    }
  }
  return (
    itemStep(last.items) ??
    currentStep(buildTranscript(last.content, last.id).blocks)
  )
}

/**
 * "Testing · pnpm vitest run": the phase says what the step is for, and the
 * detail says what it is — the tool's own name ("Shell") adds nothing at
 * sidebar width once both are known.
 */
function stepLine(step: LiveStep): string {
  const phase = stepPhaseLabel(step)
  if (step.kind === "tool" && step.phase && step.phase !== "working") {
    return `${phase} · ${step.detail ?? step.label}`
  }
  const head = step.kind === "tool" ? step.label : phase
  return step.detail ? `${head} · ${step.detail}` : head
}

/**
 * The sidebar's second line for a chat that needs a glance: what it is doing
 * right now, or why it stopped. Null for a chat at rest — a list of thirty
 * idle threads should not say "Idle" thirty times.
 */
export function sessionStateLine(
  session: SessionMeta,
  messages?: readonly ChatMessage[],
): string | null {
  switch (session.status) {
    case "running": {
      const step = runningStep(session, messages)
      return step ? stepLine(step) : "Working"
    }
    case "waiting_input":
      return "Waiting for your answer"
    case "error":
      return cutByRestart(messages)
        ? "Interrupted by a restart — send “continue”"
        : "Stopped with an error"
    default:
      return null
  }
}
