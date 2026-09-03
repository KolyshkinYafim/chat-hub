import { oneLine } from "@shared/text"
import { describeItem } from "@shared/live"
import type { AgentTurnItem, SessionLiveActivity } from "@shared/types"

const DETAIL_MAX = 80

type TrackedSession = {
  activity: SessionLiveActivity
  openItems: Map<string, AgentTurnItem>
}

export class LiveActivityTracker {
  private tracked = new Map<string, TrackedSession>()

  begin(sessionId: string, now = Date.now()): SessionLiveActivity {
    const activity: SessionLiveActivity = {
      phase: "connecting",
      stepLabel: "Connecting",
      since: now,
      startedAt: now,
    }
    this.tracked.set(sessionId, { activity, openItems: new Map() })
    return activity
  }

  delta(sessionId: string, now = Date.now()): SessionLiveActivity | null {
    const entry = this.tracked.get(sessionId)
    if (!entry) return null
    if (this.hasOpenAction(entry)) return null
    return this.apply(entry, "thinking", "Writing", undefined, now)
  }

  item(
    sessionId: string,
    item: AgentTurnItem,
    now = Date.now(),
  ): SessionLiveActivity | null {
    const entry = this.tracked.get(sessionId)
    if (!entry) return null
    if (item.status === "running" || item.status === "pending") {
      entry.openItems.set(item.id, item)
    } else {
      entry.openItems.delete(item.id)
    }
    const action = this.currentAction(entry)
    if (action) {
      const { label, detail } = describeItem(action)
      return this.apply(
        entry,
        "tool",
        label,
        detail ? oneLine(detail, DETAIL_MAX) : undefined,
        now,
      )
    }
    return this.apply(entry, "thinking", "Thinking", undefined, now)
  }

  clear(sessionId: string): boolean {
    return this.tracked.delete(sessionId)
  }

  get(sessionId: string): SessionLiveActivity | undefined {
    return this.tracked.get(sessionId)?.activity
  }

  private hasOpenAction(entry: TrackedSession): boolean {
    return this.currentAction(entry) !== null
  }

  private currentAction(entry: TrackedSession): AgentTurnItem | null {
    const actions = [...entry.openItems.values()].filter(
      (item) => item.kind !== "reasoning",
    )
    return (
      [...actions].reverse().find((item) => item.status === "running") ??
      actions.find((item) => item.status === "pending") ??
      null
    )
  }

  private apply(
    entry: TrackedSession,
    phase: SessionLiveActivity["phase"],
    stepLabel: string,
    stepDetail: string | undefined,
    now: number,
  ): SessionLiveActivity | null {
    const current = entry.activity
    if (
      current.phase === phase &&
      current.stepLabel === stepLabel &&
      current.stepDetail === stepDetail
    ) {
      return null
    }
    entry.activity = {
      phase,
      stepLabel,
      ...(stepDetail === undefined ? {} : { stepDetail }),
      since: now,
      startedAt: current.startedAt,
    }
    return entry.activity
  }
}
