export const COCKPIT_ENV = "CHAT_HUB_COCKPIT"
export const COCKPIT_VIBRANCY_ENV = "CHAT_HUB_COCKPIT_VIBRANCY"

export type CockpitVibrancy = "under-window" | "hud"

export type CockpitWindow = {
  enabled: boolean
  vibrancy: CockpitVibrancy
}

function lastMatching(
  argv: string[],
  match: (value: string) => string | null,
): string | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const hit = match(argv[i])
    if (hit !== null) return hit
  }
  return null
}

function cockpitArgValue(arg: string): string | null {
  if (arg === "--chat-hub-cockpit") return "1"
  if (arg.startsWith("--chat-hub-cockpit=")) return arg.slice("--chat-hub-cockpit=".length)
  return null
}

function vibrancyArgValue(arg: string): string | null {
  if (arg.startsWith("--chat-hub-cockpit-vibrancy=")) {
    return arg.slice("--chat-hub-cockpit-vibrancy=".length)
  }
  return null
}

export function parseCockpitEnabled(
  argv: string[],
  env: Record<string, string | undefined>,
): boolean {
  const arg = lastMatching(argv, cockpitArgValue)
  if (arg === "0") return false
  if (arg === "1") return true
  return env[COCKPIT_ENV] === "1"
}

export function parseCockpitVibrancy(
  argv: string[],
  env: Record<string, string | undefined>,
): CockpitVibrancy {
  const arg = lastMatching(argv, vibrancyArgValue)
  if (arg === "hud" || arg === "under-window") return arg
  return env[COCKPIT_VIBRANCY_ENV] === "hud" ? "hud" : "under-window"
}

export function parseCockpitFlags(
  argv: string[],
  env: Record<string, string | undefined>,
): CockpitWindow {
  return {
    enabled: parseCockpitEnabled(argv, env),
    vibrancy: parseCockpitVibrancy(argv, env),
  }
}

export function parseCockpitSearch(search: string): CockpitWindow {
  const query = search.startsWith("?") ? search.slice(1) : search
  const params = new URLSearchParams(query)
  const vibrancy = params.get("vibrancy")
  return {
    enabled: params.get("cockpit") === "1",
    vibrancy: vibrancy === "hud" ? "hud" : "under-window",
  }
}

export function withCockpitArg(argv: string[], enabled: boolean): string[] {
  const rest = argv.filter(
    (a) => a !== "--chat-hub-cockpit" && !a.startsWith("--chat-hub-cockpit="),
  )
  rest.push(enabled ? "--chat-hub-cockpit=1" : "--chat-hub-cockpit=0")
  return rest
}

export function withCockpitVibrancyArg(
  argv: string[],
  vibrancy: CockpitVibrancy,
): string[] {
  const rest = argv.filter((a) => !a.startsWith("--chat-hub-cockpit-vibrancy"))
  rest.push(`--chat-hub-cockpit-vibrancy=${vibrancy}`)
  return rest
}
