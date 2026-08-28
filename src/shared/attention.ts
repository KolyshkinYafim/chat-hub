import type { SessionMeta, SessionStatus } from "./types"

export const STATUS_RANK: Record<SessionStatus, number> = {
  running: 0,
  waiting_input: 1,
  error: 2,
  idle: 3,
  done: 3,
}

export function attentionEligible(session: SessionMeta): boolean {
  return !session.archived && session.settledAt === undefined
}

export function activityStamp(session: SessionMeta): number {
  return session.activityAt ?? session.updatedAt
}

export function needsAction(session: SessionMeta): boolean {
  if (!attentionEligible(session)) return false
  return session.status === "waiting_input" || session.status === "error"
}

export function attentionBadge(count: number): string {
  return count > 0 ? String(Math.floor(count)) : ""
}
