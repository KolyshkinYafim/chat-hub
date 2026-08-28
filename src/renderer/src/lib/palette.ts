import type { SessionMeta } from "@shared/types"
import { fuzzyScore } from "./fuzzy"

export const NEXT_ATTENTION_KEY = "command:next-attention"
export const NEXT_ATTENTION_MATCH = "next waiting needs you attention jump"

const MAX_SESSION_RESULTS = 12

export type PaletteEntry =
  | { kind: "command"; label: string; sub: string }
  | { kind: "session"; session: SessionMeta }

export function paletteKey(entry: PaletteEntry): string {
  return entry.kind === "command" ? NEXT_ATTENTION_KEY : entry.session.id
}

export function buildPaletteEntries(
  sessions: readonly SessionMeta[],
  query: string,
  attentionCount: number,
): PaletteEntry[] {
  const scored: { session: SessionMeta; score: number }[] = []
  for (const s of sessions) {
    const score = fuzzyScore(query, `${s.title} ${s.project} ${s.provider}`)
    if (score !== null) scored.push({ session: s, score })
  }
  scored.sort(
    (a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt,
  )
  const top = scored.slice(0, MAX_SESSION_RESULTS)
  const entries: PaletteEntry[] = top.map(({ session }) => ({
    kind: "session",
    session,
  }))

  const commandScore =
    attentionCount > 0 ? fuzzyScore(query, NEXT_ATTENTION_MATCH) : null
  if (commandScore === null) return entries
  const outscored = top.findIndex(({ score }) => commandScore > score)
  entries.splice(outscored === -1 ? entries.length : outscored, 0, {
    kind: "command",
    label: "Next waiting",
    sub: `Jump to the next session that needs you · ${attentionCount} in queue`,
  })
  return entries
}

export type PaletteCursor = { key: string | null; index: number }

export function resolvePaletteCursor(
  keys: readonly string[],
  cursor: PaletteCursor,
): number {
  if (keys.length === 0) return 0
  if (cursor.key !== null) {
    const found = keys.indexOf(cursor.key)
    if (found !== -1) return found
  }
  return Math.min(Math.max(cursor.index, 0), keys.length - 1)
}
