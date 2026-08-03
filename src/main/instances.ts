import type { ProviderId } from "@shared/types"

/**
 * Env var each CLI reads to relocate its config/login home. Setting this lets a
 * second "instance" of a provider use a different account than the default.
 */
export const HOME_ENV: Partial<Record<ProviderId, string>> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
  opencode: "OPENCODE_CONFIG",
}

/** The default config-home each provider uses when no override is set. */
export const DEFAULT_HOME: Partial<Record<ProviderId, string>> = {
  claude: ".claude",
  codex: ".codex",
  grok: ".grok",
  opencode: ".config/opencode",
}

/** Build the env fragment that points a provider at a shadow config-home. */
export function homeEnvFor(
  provider: ProviderId,
  homeDir: string | undefined | null,
): Record<string, string> {
  const key = HOME_ENV[provider]
  if (!key || !homeDir) return {}
  return { [key]: homeDir }
}
