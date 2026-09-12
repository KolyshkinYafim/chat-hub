import type { SlashCommand } from "@shared/slash-commands"
import { fuzzyScore } from "./fuzzy"

export const MAX_SLASH_RESULTS = 8

/**
 * The name being typed when the draft is a slash command in progress: `/`
 * at the very start and no whitespace yet. `null` once a space or newline
 * follows the name — the command is chosen, the rest is its arguments.
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null
  const name = draft.slice(1)
  if (/\s/.test(name)) return null
  return name
}

/** Fuzzy on the name only; an empty query lists everything in disk order. */
export function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
  limit = MAX_SLASH_RESULTS,
): SlashCommand[] {
  if (!query) return commands.slice(0, limit)
  const scored: { cmd: SlashCommand; score: number }[] = []
  for (const cmd of commands) {
    const score = fuzzyScore(query, cmd.name)
    if (score === null) continue
    // A prefix hit is what the terminal would complete to; keep it on top.
    scored.push({ cmd, score: cmd.name.startsWith(query) ? score + 100 : score })
  }
  scored.sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name))
  return scored.slice(0, limit).map((s) => s.cmd)
}

/** Replace the half-typed name with the chosen one, ready for arguments. */
export function insertSlashCommand(name: string): string {
  return `/${name} `
}
