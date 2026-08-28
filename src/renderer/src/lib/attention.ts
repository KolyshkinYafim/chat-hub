import type { SessionMeta } from "@shared/types"
import { needsAction } from "@shared/attention"

export type AttentionSeen = Readonly<Record<string, number>>

export const DONE_SEEN_DWELL_MS = 1500
export const RESORT_INTERVAL_MS = 3 * 60_000

export function isUnseenDone(
  session: SessionMeta,
  seen: AttentionSeen,
): boolean {
  if (session.status !== "done") return false
  if (session.archived || session.settledAt !== undefined) return false
  return (seen[session.id] ?? 0) < session.updatedAt
}

export function needsAttention(
  session: SessionMeta,
  seen: AttentionSeen,
): boolean {
  return needsAction(session) || isUnseenDone(session, seen)
}

const CLASS_RANK: Partial<Record<SessionMeta["status"], number>> = {
  waiting_input: 0,
  error: 1,
  done: 2,
}

export function attentionQueue(
  sessions: readonly SessionMeta[],
  seen: AttentionSeen,
): SessionMeta[] {
  return sessions
    .filter((s) => needsAttention(s, seen))
    .sort(
      (a, b) =>
        (CLASS_RANK[a.status] ?? 3) - (CLASS_RANK[b.status] ?? 3) ||
        a.updatedAt - b.updatedAt ||
        a.id.localeCompare(b.id),
    )
}

export function nextAttention(
  queue: readonly SessionMeta[],
  currentId: string | null,
): SessionMeta | null {
  if (queue.length === 0) return null
  const at = currentId === null ? -1 : queue.findIndex((s) => s.id === currentId)
  return queue[(at + 1) % queue.length]
}

export function markSeen(
  seen: AttentionSeen,
  sessionId: string,
  seenUpdatedAt: number,
): AttentionSeen {
  if ((seen[sessionId] ?? 0) >= seenUpdatedAt) return seen
  return { ...seen, [sessionId]: seenUpdatedAt }
}

export function pruneSeen(
  seen: AttentionSeen,
  liveIds: ReadonlySet<string>,
): AttentionSeen {
  const kept = Object.entries(seen).filter(([id]) => liveIds.has(id))
  if (kept.length === Object.keys(seen).length) return seen
  return Object.fromEntries(kept)
}

export type DampedOrder = {
  order: readonly string[]
  resortedAt: number | null
}

export function dampOrder(
  prev: DampedOrder | null,
  desired: readonly string[],
  now: number,
): DampedOrder {
  if (!prev) return { order: [...desired], resortedAt: null }
  const merged = mergeMembership(prev.order, desired)
  const budgetFree =
    prev.resortedAt === null || now - prev.resortedAt >= RESORT_INTERVAL_MS
  if (!sameOrder(merged, desired) && budgetFree) {
    return { order: [...desired], resortedAt: now }
  }
  return sameOrder(prev.order, merged)
    ? prev
    : { order: merged, resortedAt: prev.resortedAt }
}

function mergeMembership(
  committed: readonly string[],
  desired: readonly string[],
): string[] {
  const wanted = new Set(desired)
  const merged = committed.filter((id) => wanted.has(id))
  const present = new Set(merged)
  const rank = new Map(desired.map((id, index) => [id, index]))
  for (const id of desired) {
    if (present.has(id)) continue
    const own = rank.get(id) ?? 0
    let insertAt = merged.length
    for (let i = 0; i < merged.length; i++) {
      const other = rank.get(merged[i])
      if (other !== undefined && other > own) {
        insertAt = i
        break
      }
    }
    merged.splice(insertAt, 0, id)
    present.add(id)
  }
  return merged
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}
