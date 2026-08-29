import type { SessionMeta } from "@shared/types"
import { fuzzyScore } from "./fuzzy"

export const NEXT_ATTENTION_KEY = "command:next-attention"
export const NEXT_ATTENTION_MATCH = "next waiting needs you attention jump"
export const NEW_WINDOW_KEY = "command:new-window"
export const NEW_WINDOW_MATCH = "new window open another window"

const MAX_SESSION_RESULTS = 12

/** Commands carry their own key: two of them must not collide on one id. */
export type PaletteCommandKey =
  | typeof NEXT_ATTENTION_KEY
  | typeof NEW_WINDOW_KEY

export type PaletteEntry =
  | { kind: "command"; key: PaletteCommandKey; label: string; sub: string }
  | { kind: "session"; session: SessionMeta }

export function paletteKey(entry: PaletteEntry): string {
  return entry.kind === "command" ? entry.key : entry.session.id
}

type CommandCandidate = { match: string; entry: PaletteEntry }

function commandCandidates(attentionCount: number): CommandCandidate[] {
  const out: CommandCandidate[] = []
  if (attentionCount > 0) {
    out.push({
      match: NEXT_ATTENTION_MATCH,
      entry: {
        kind: "command",
        key: NEXT_ATTENTION_KEY,
        label: "Next waiting",
        sub: `Jump to the next session that needs you · ${attentionCount} in queue`,
      },
    })
  }
  out.push({
    match: NEW_WINDOW_MATCH,
    entry: {
      kind: "command",
      key: NEW_WINDOW_KEY,
      label: "New Window",
      sub: "Open another window on the same sessions · ⌘⇧N",
    },
  })
  return out
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

  const ranked: { entry: PaletteEntry; score: number }[] = top.map(
    ({ session, score }) => ({ entry: { kind: "session", session }, score }),
  )
  for (const candidate of commandCandidates(attentionCount)) {
    const score = fuzzyScore(query, candidate.match)
    if (score === null) continue
    ranked.push({ entry: candidate.entry, score })
  }

  // Sorting is stable, and the commands were appended after the sessions — so a
  // command only climbs past a session it strictly outscores, and an empty
  // query (everything at zero) leaves them below the recent chats.
  ranked.sort((a, b) => b.score - a.score)
  return ranked.map(({ entry }) => entry)
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
