import type { SessionMeta } from "@shared/types"

export type RowContext = {
  /** True while a query is typed: the sidebar then searches everything. */
  searching: boolean
  activeId: string | null
}

/**
 * Which sessions the project groups list. Settled threads step out of the way
 * so the groups stay a list of live work — except the open one, which is always
 * listed: a thread vanishing from the sidebar while its transcript is on screen
 * reads as data loss. A search sees every unarchived session, since nearly all
 * past work settles and would otherwise be unfindable.
 */
export function belongsInProjectGroups(
  session: SessionMeta,
  ctx: RowContext,
): boolean {
  if (session.archived) return false
  if (ctx.searching) return true
  return session.settledAt === undefined || session.id === ctx.activeId
}

/** The Settled group holds what the project groups let go of, and nothing else. */
export function belongsInSettledGroup(
  session: SessionMeta,
  ctx: RowContext,
): boolean {
  if (session.archived || ctx.searching) return false
  return session.settledAt !== undefined && session.id !== ctx.activeId
}
