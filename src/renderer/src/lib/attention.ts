import type { SessionMeta } from "@shared/types"
import {
  activityStamp,
  attentionEligible,
  needsAction,
  STATUS_RANK,
} from "@shared/attention"

export type AttentionSeen = Readonly<Record<string, number>>

export const DONE_SEEN_DWELL_MS = 1500
export const RESORT_INTERVAL_MS = 3 * 60_000

export function isUnseenDone(
  session: SessionMeta,
  seen: AttentionSeen,
): boolean {
  if (session.status !== "done") return false
  if (!attentionEligible(session)) return false
  return (seen[session.id] ?? 0) < activityStamp(session)
}

export function needsAttention(
  session: SessionMeta,
  seen: AttentionSeen,
): boolean {
  return needsAction(session) || isUnseenDone(session, seen)
}

export function attentionQueue(
  sessions: readonly SessionMeta[],
  seen: AttentionSeen,
): SessionMeta[] {
  return sessions
    .filter((s) => needsAttention(s, seen))
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        activityStamp(a) - activityStamp(b) ||
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
  stamp: number,
): AttentionSeen {
  if ((seen[sessionId] ?? 0) >= stamp) return seen
  return { ...seen, [sessionId]: stamp }
}

export function parseAttentionSeen(raw: string | null): AttentionSeen {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === "number" && Number.isFinite(at)) out[id] = at
    }
    return out
  } catch {
    return {}
  }
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

export function mergeMembership(
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
