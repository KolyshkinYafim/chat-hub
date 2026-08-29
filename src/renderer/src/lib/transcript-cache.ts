/**
 * Which transcripts the renderer keeps. Panes are never dropped — they are on
 * screen — and behind them sits a short most-recently-viewed list, so flipping
 * between a handful of chats stays instant without the whole store creeping
 * back into memory.
 */

export const TRANSCRIPT_LRU = 8

/** Newest first, capped. Returns the same array when nothing moved. */
export function touchRecent(
  recent: readonly string[],
  id: string,
  limit = TRANSCRIPT_LRU,
): readonly string[] {
  const cap = Math.max(1, limit)
  if (recent[0] === id && recent.length <= cap) return recent
  return [id, ...recent.filter((known) => known !== id)].slice(0, cap)
}

export function retainedTranscripts(
  paneIds: readonly (string | null)[],
  recent: readonly string[],
): Set<string> {
  const keep = new Set<string>(recent)
  for (const id of paneIds) {
    if (id) keep.add(id)
  }
  return keep
}

export function evictableTranscripts(
  loaded: Iterable<string>,
  keep: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  for (const id of loaded) {
    if (!keep.has(id)) out.push(id)
  }
  return out
}

export function withoutKeys<T>(
  record: Record<string, T>,
  ids: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(record).filter(([key]) => !ids.has(key))
  if (entries.length === Object.keys(record).length) return record
  return Object.fromEntries(entries)
}
