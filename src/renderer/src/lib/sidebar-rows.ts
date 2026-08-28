import type { SessionMeta } from "@shared/types"
import { needsAttention, type AttentionSeen } from "./attention"

export type RowContext = {
  /** True while a query is typed: the sidebar then searches everything. */
  searching: boolean
  statusFiltered: boolean
  activeId: string | null
  seen: AttentionSeen
}

export function belongsInNeedsYouGroup(
  session: SessionMeta,
  ctx: RowContext,
): boolean {
  if (ctx.searching || ctx.statusFiltered) return false
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
  if (belongsInNeedsYouGroup(session, ctx)) return false
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
  if (belongsInNeedsYouGroup(session, ctx)) return false
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

export type SidebarBucket =
  | "needs-you"
  | "favorites"
  | "projects"
  | "settled"
  | "archived"

export function sessionBucket(
  session: SessionMeta,
  ctx: RowContext,
): SidebarBucket {
  if (session.archived) return "archived"
  if (belongsInNeedsYouGroup(session, ctx)) return "needs-you"
  if (belongsInFavoritesGroup(session, ctx)) return "favorites"
  if (belongsInSettledGroup(session, ctx)) return "settled"
  return "projects"
}

export type RowHold = {
  session: SessionMeta
  seen: AttentionSeen
  queueIndex: number
}

export type SidebarRows = {
  needsYou: SessionMeta[]
  favorites: SessionMeta[]
  projects: SessionMeta[]
  settled: SessionMeta[]
  archived: SessionMeta[]
}

export function partitionSidebarRows(
  sessions: readonly SessionMeta[],
  needsYouQueue: readonly SessionMeta[],
  ctx: RowContext,
  hold: RowHold | null,
): SidebarRows {
  const bucketOf = (session: SessionMeta): SidebarBucket =>
    hold && session.id === hold.session.id
      ? sessionBucket(hold.session, { ...ctx, seen: hold.seen })
      : sessionBucket(session, ctx)

  const newestFirst = (a: SessionMeta, b: SessionMeta) =>
    b.updatedAt - a.updatedAt
  const inBucket = (bucket: SidebarBucket) =>
    sessions.filter((session) => bucketOf(session) === bucket)

  const needsYou = needsYouQueue.filter(
    (session) => bucketOf(session) === "needs-you",
  )
  if (hold && !needsYou.some((session) => session.id === hold.session.id)) {
    const live = sessions.find((session) => session.id === hold.session.id)
    if (live && bucketOf(live) === "needs-you") {
      const at = hold.queueIndex < 0 ? needsYou.length : hold.queueIndex
      needsYou.splice(Math.min(at, needsYou.length), 0, live)
    }
  }

  return {
    needsYou,
    favorites: inBucket("favorites").sort(newestFirst),
    projects: inBucket("projects"),
    settled: inBucket("settled").sort(newestFirst),
    archived: inBucket("archived").sort(newestFirst),
  }
}
