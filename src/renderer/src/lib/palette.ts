import type { SessionMeta } from "@shared/types"
import { fuzzyScore } from "./fuzzy"

export const NEXT_ATTENTION_KEY = "command:next-attention"
export const NEXT_ATTENTION_MATCH = "next waiting needs you attention jump"
export const AGENT_INBOX_KEY = "command:agent-inbox"
export const AGENT_INBOX_MATCH =
  "agent inbox panel permission question failed"

const MAX_SESSION_RESULTS = 12

export type PaletteCommand = {
  kind: "command"
  key: string
  label: string
  sub: string
  hint: string
}

export type PaletteEntry = PaletteCommand | { kind: "session"; session: SessionMeta }

export function paletteKey(entry: PaletteEntry): string {
  return entry.kind === "command" ? entry.key : entry.session.id
}

export function buildPaletteEntries(
  sessions: readonly SessionMeta[],
  query: string,
  attentionCount: number,
  inboxCount = 0,
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

  const commands: { score: number; entry: PaletteCommand }[] = []
  const inboxScore = fuzzyScore(query, AGENT_INBOX_MATCH)
  if (inboxScore !== null) {
    commands.push({
      score: inboxScore,
      entry: {
        kind: "command",
        key: AGENT_INBOX_KEY,
        label: "Agent inbox",
        sub:
          inboxCount > 0
            ? `${inboxCount} waiting · permissions, questions and failures`
            : "Review pending permissions, questions and failures",
        hint: "⌥⇧I",
      },
    })
  }
  const nextScore =
    attentionCount > 0 ? fuzzyScore(query, NEXT_ATTENTION_MATCH) : null
  if (nextScore !== null) {
    commands.push({
      score: nextScore,
      entry: {
        kind: "command",
        key: NEXT_ATTENTION_KEY,
        label: "Next waiting",
        sub: `Jump to the next session that needs you · ${attentionCount} in queue`,
        hint: "⌥⇧U",
      },
    })
  }
  commands.sort((a, b) => a.score - b.score || a.entry.key.localeCompare(b.entry.key))
  for (const command of commands) {
    const outscored = top.findIndex(({ score }) => command.score > score)
    entries.splice(outscored === -1 ? entries.length : outscored, 0, command.entry)
  }
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
