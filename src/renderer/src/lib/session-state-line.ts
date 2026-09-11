import type { ChatMessage, SessionMeta } from "@shared/types"
import { RESTART_CUT_TITLE } from "@shared/notices"
import { livePhase } from "./live-step"
import { phaseLabel } from "@shared/live"

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
      const live = session.live
      if (live) {
        return live.stepDetail
          ? `${live.stepLabel} · ${live.stepDetail}`
          : live.stepLabel
      }
      const phase = livePhase(messages, session.status)
      return phase ? phaseLabel[phase] : "Working"
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
