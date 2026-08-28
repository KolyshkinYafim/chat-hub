import type { SessionMeta } from "./types"

export function needsAction(session: SessionMeta): boolean {
  if (session.archived || session.settledAt !== undefined) return false
  return session.status === "waiting_input" || session.status === "error"
}

export function attentionBadge(sessions: readonly SessionMeta[]): string {
  const count = sessions.filter(needsAction).length
  return count === 0 ? "" : String(count)
}
