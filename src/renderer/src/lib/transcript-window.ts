import type { ChatMessage } from "@shared/types"

/**
 * Main keeps only the newest `MAX_MESSAGES_PER_SESSION` turns in memory and
 * re-sends that window whenever a session is focused. The renderer may be
 * holding older turns it pulled out of the on-disk archive, so a replacement is
 * merged onto the head instead of overwriting it: whatever sits before the
 * window's first message survives, and the window itself always wins.
 */
export function mergeReplacedMessages(
  existing: readonly ChatMessage[],
  replacement: readonly ChatMessage[],
): ChatMessage[] {
  if (existing.length === 0 || replacement.length === 0) {
    return [...replacement]
  }
  const inWindow = new Set(replacement.map((m) => m.id))
  const overlap = existing.findIndex((m) => inWindow.has(m.id))
  if (overlap <= 0) return [...replacement]
  return [...existing.slice(0, overlap), ...replacement]
}

/**
 * Fold a `getMessages` answer into whatever live events piled up while it was
 * in flight. The fetched window is authoritative for every id it carries — main
 * had already folded those deltas in before it replied, so taking the local copy
 * would double them — and anything the events introduced that the window does
 * not mention is newer than the window, so it keeps its arrival order at the end.
 */
export function reconcileFetchedMessages(
  live: readonly ChatMessage[],
  fetched: readonly ChatMessage[],
): ChatMessage[] {
  if (live.length === 0) return [...fetched]
  const inWindow = new Set(fetched.map((m) => m.id))
  const after = live.filter((m) => !inWindow.has(m.id))
  if (after.length === 0) return [...fetched]
  return [...fetched, ...after]
}
