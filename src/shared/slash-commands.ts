import type { ProviderId } from "./types"

/**
 * A `/name` the CLI would expand for this project: a Claude Code skill or
 * custom command, or a Codex saved prompt. Discovery only — the Hub never
 * runs these itself, it just puts the name in the composer.
 */
export type SlashCommand = {
  name: string
  description: string
  /** Project files (under the cwd) win over the user's home-directory ones. */
  source: "project" | "user"
  provider: ProviderId
}
