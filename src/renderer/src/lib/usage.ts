import type { SessionUsage, TurnUsage } from "@shared/types"
import { formatTokens } from "@shared/context-window"

export { formatTokens }

export function formatUsd(n: number): string {
  // Most single turns land under a cent, where two decimals read as free.
  return n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`
}

/** Billable tokens, i.e. what the CLI actually reported — cache reads excluded. */
export function totalTokens(usage: TurnUsage): number | null {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return null
  }
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

/**
 * Renders only the fields the CLI reported. Returns null when it reported none,
 * so callers hide the chip instead of showing a $0 the user might act on.
 */
export function formatUsage(usage: TurnUsage): string | null {
  const parts: string[] = []
  if (usage.costUsd !== undefined) parts.push(formatUsd(usage.costUsd))
  const tokens = totalTokens(usage)
  if (tokens !== null) parts.push(`${formatTokens(tokens)} tok`)
  return parts.length > 0 ? parts.join(" · ") : null
}

/** Footer label for a whole session: totals plus the turn count behind them. */
export function formatSessionUsage(usage: SessionUsage): string | null {
  const head = formatUsage(usage)
  if (!head) return null
  return `${head} · ${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`
}

/** Hover text spelling out the parts the one-line label folds together. */
export function usageDetail(usage: TurnUsage): string {
  const rows: string[] = []
  if (usage.inputTokens !== undefined) {
    rows.push(`in ${formatTokens(usage.inputTokens)}`)
  }
  if (usage.outputTokens !== undefined) {
    rows.push(`out ${formatTokens(usage.outputTokens)}`)
  }
  if (usage.cacheReadTokens !== undefined) {
    rows.push(`cache read ${formatTokens(usage.cacheReadTokens)}`)
  }
  if (usage.cacheCreateTokens !== undefined) {
    rows.push(`cache write ${formatTokens(usage.cacheCreateTokens)}`)
  }
  if (usage.durationMs !== undefined) {
    rows.push(`${(usage.durationMs / 1000).toFixed(1)}s`)
  }
  return rows.join(" · ")
}
