import { fuzzyScore } from "./fuzzy"

export function mruOrder<T extends { id: string; updatedAt: number }>(
  sessions: readonly T[],
  recent: readonly string[],
): T[] {
  const rank = new Map(recent.map((id, index) => [id, index]))
  return [...sessions].sort((a, b) => {
    const rankA = rank.get(a.id)
    const rankB = rank.get(b.id)
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB
    if (rankA !== undefined) return -1
    if (rankB !== undefined) return 1
    return b.updatedAt - a.updatedAt
  })
}

export function filterByQuery<
  T extends { title: string; project: string; provider: string },
>(entries: readonly T[], query: string): T[] {
  if (!query.trim()) return [...entries]
  const scored: { entry: T; score: number }[] = []
  for (const entry of entries) {
    const score = fuzzyScore(
      query,
      `${entry.title} ${entry.project} ${entry.provider}`,
    )
    if (score !== null) scored.push({ entry, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((hit) => hit.entry)
}

export function cycleIndex(
  cursor: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return 0
  const from = Math.min(Math.max(cursor, 0), length - 1)
  return (from + delta + length) % length
}

export function initialCursor(length: number): number {
  return length > 1 ? 1 : 0
}

export function shouldOpenSwitcher(sessionCount: number): boolean {
  return sessionCount >= 2
}

export function commitTarget<T>(
  visible: readonly T[],
  cursor: number,
): T | null {
  if (visible.length === 0) return null
  return visible[Math.min(Math.max(cursor, 0), visible.length - 1)]
}
