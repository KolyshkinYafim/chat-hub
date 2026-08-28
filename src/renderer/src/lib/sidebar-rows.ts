import type { SessionMeta } from "@shared/types"
import { needsAttention, type AttentionSeen } from "./attention"

export type RowContext = {
  /** True while a query is typed: the sidebar then searches everything. */
  searching: boolean
  activeId: string | null
  seen: AttentionSeen
}

export function belongsInNeedsYouGroup(
  session: SessionMeta,
  ctx: RowContext,
): boolean {
  if (session.archived || ctx.searching) return false
  return needsAttention(session, ctx.seen)
}

/**
 * The Favorites group, pinned above the projects. A favourite is lifted out of
 * its project group rather than copied into both, and stays listed once it
 * settles — keeping it reachable is the point of favouriting it. While it needs
 * attention it moves to Needs you instead, so triage reads off one group. A
 * search falls back to the project groups so every hit is listed in one place.
 */
export function belongsInFavoritesGroup(
  session: SessionMeta,
  ctx: RowContext,
): boolean {
  if (session.archived || ctx.searching) return false
  if (needsAttention(session, ctx.seen)) return false
  return session.favorite === true
}

/**
 * Which sessions the project groups list. Settled threads step out of the way
 * so the groups stay a list of live work — except the open one, which is always
 * listed: a thread vanishing from the sidebar while its transcript is on screen
 * reads as data loss. A favourite is already pinned above and needs no such
 * rescue. A search sees every unarchived session, since nearly all past work
 * settles and would otherwise be unfindable.
 */
export function belongsInProjectGroups(
  session: SessionMeta,
  ctx: RowContext,
): boolean {
  if (session.archived) return false
  if (ctx.searching) return true
  if (needsAttention(session, ctx.seen)) return false
  if (session.favorite) return false
  return session.settledAt === undefined || session.id === ctx.activeId
}

/** The Settled group holds what the project groups let go of, and nothing else. */
export function belongsInSettledGroup(
  session: SessionMeta,
  ctx: RowContext,
): boolean {
  if (session.archived || ctx.searching) return false
  if (session.favorite) return false
  return session.settledAt !== undefined && session.id !== ctx.activeId
}
