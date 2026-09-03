import type { SessionMeta } from "@shared/types"
import { fuzzyScore } from "./fuzzy"

export const NEXT_ATTENTION_KEY = "command:next-attention"
export const NEXT_ATTENTION_MATCH = "next waiting needs you attention jump"
export const AGENT_INBOX_KEY = "command:agent-inbox"
export const AGENT_INBOX_MATCH =
  "agent inbox panel permission question failed"
export const NEW_WINDOW_KEY = "command:new-window"
export const NEW_WINDOW_MATCH = "new window open another window"

const MAX_SESSION_RESULTS = 12

export type PaletteCommand = {
  kind: "command"
  key: string
  label: string
  sub: string
  hint: string
}

export type PaletteEntry =
  | PaletteCommand
  | { kind: "session"; session: SessionMeta }

export function paletteKey(entry: PaletteEntry): string {
  return entry.kind === "command" ? entry.key : entry.session.id
}

type CommandCandidate = { match: string; entry: PaletteCommand }

function commandCandidates(
  attentionCount: number,
  inboxCount: number,
): CommandCandidate[] {
  const out: CommandCandidate[] = []
  if (attentionCount > 0) {
    out.push({
      match: NEXT_ATTENTION_MATCH,
      entry: {
        kind: "command",
        key: NEXT_ATTENTION_KEY,
        label: "Next waiting",
        sub: `Jump to the next session that needs you · ${attentionCount} in queue`,
        hint: "⌥⇧U",
      },
    })
  }
  out.push({
    match: AGENT_INBOX_MATCH,
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
  out.push({
    match: NEW_WINDOW_MATCH,
    entry: {
      kind: "command",
      key: NEW_WINDOW_KEY,
      label: "New Window",
      sub: "Open another window on the same sessions",
      hint: "⌘⇧N",
    },
  })
  return out
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

  const ranked: { entry: PaletteEntry; score: number }[] = top.map(
    ({ session, score }) => ({ entry: { kind: "session", session }, score }),
  )
  for (const candidate of commandCandidates(attentionCount, inboxCount)) {
    const score = fuzzyScore(query, candidate.match)
    if (score === null) continue
    ranked.push({ entry: candidate.entry, score })
  }

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
