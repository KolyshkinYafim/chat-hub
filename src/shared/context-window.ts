import type { TurnUsage } from "./types"

/** Single k/M token formatter — the cost chips and the context meter must agree. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 999_500) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  const m = (n / 1_000_000).toFixed(1)
  return `${m.endsWith(".0") ? m.slice(0, -2) : m}M`
}

const FALLBACK_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ["claude-fable-5", 1_000_000],
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["opus", 200_000],
  ["sonnet", 200_000],
  ["haiku", 200_000],
  ["gpt-5-codex", 272_000],
  ["gpt-5", 272_000],
]

/**
 * What of the window the last turn actually occupied: prompt input plus every
 * cached token read or written — output lives outside the input window.
 */
export function contextUsedTokens(usage: TurnUsage): number | null {
  if (
    usage.inputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheCreateTokens === undefined
  ) {
    return null
  }
  return (
    (usage.inputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheCreateTokens ?? 0)
  )
}

/**
 * A window the CLI reported at runtime always wins; the table only covers
 * well-known model ids, and an unknown model yields null so the meter hides
 * rather than guesses.
 */
export function contextWindowFor(
  model: string | undefined,
  reported: number | undefined,
): number | null {
  if (reported !== undefined && Number.isFinite(reported) && reported > 0) {
    return reported
  }
  if (!model) return null
  const id = model.toLowerCase()
  for (const [prefix, window] of FALLBACK_WINDOWS) {
    if (id === prefix || id.startsWith(prefix)) return window
  }
  return null
}

export function formatContextMeter(
  used: number,
  window: number,
): { label: string; ratio: number } {
  const raw = window > 0 ? used / window : 0
  const ratio = Math.min(1, Math.max(0, raw))
  const label = `${formatTokens(used)} / ${formatTokens(window)} · ${Math.round(ratio * 100)}%`
  return { label, ratio }
}
