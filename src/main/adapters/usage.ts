import type { SessionUsage, TurnUsage } from "@shared/types"

/**
 * Cost/token extraction from a CLI's NDJSON line.
 *
 * Four CLIs, four spellings of the same numbers, and every one of them changes
 * between releases — so this reads by key alias instead of by result schema and
 * returns null when a line carries nothing. A null is what keeps the footer
 * hidden; a zeroed TurnUsage would claim a free turn.
 */

const INPUT_KEYS = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]
const OUTPUT_KEYS = [
  "output_tokens",
  "outputTokens",
  "completion_tokens",
  "completionTokens",
]
const CACHE_READ_KEYS = [
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cache_read_tokens",
  "cached_input_tokens", // codex-cli 0.146 turn.completed
  "cached_tokens",
  "read",
]
const CACHE_CREATE_KEYS = [
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cache_creation_tokens",
  "cache_write_input_tokens", // codex-cli 0.146 turn.completed
  "write",
]
const COST_KEYS = ["total_cost_usd", "totalCostUsd", "cost_usd", "costUsd", "cost"]
const DURATION_KEYS = ["duration_ms", "durationMs", "duration_api_ms"]

/** Read one turn's usage out of a stream line, or null if it says nothing. */
export function readUsage(ev: Record<string, unknown>): TurnUsage | null {
  const usage = record(ev.usage) ?? record(ev.tokens) ?? {}
  // OpenCode nests cache counts one level down; Claude keeps them flat in usage.
  const cache = record(usage.cache) ?? usage

  const out: TurnUsage = {}
  assign(out, "inputTokens", pickNumber(usage, INPUT_KEYS))
  assign(out, "outputTokens", pickNumber(usage, OUTPUT_KEYS))
  assign(out, "cacheReadTokens", pickNumber(cache, CACHE_READ_KEYS))
  assign(out, "cacheCreateTokens", pickNumber(cache, CACHE_CREATE_KEYS))
  assign(out, "costUsd", pickNumber(ev, COST_KEYS) ?? pickNumber(usage, COST_KEYS))
  assign(out, "durationMs", pickNumber(ev, DURATION_KEYS))

  if (Object.keys(out).length === 0) return null
  assign(out, "contextWindow", modelContextWindow(ev))
  return out
}

const CONTEXT_WINDOW_KEYS = ["contextWindow", "context_window"]

/**
 * The claude CLI reports the window per model under `modelUsage`; when a turn
 * touched several models, the one that occupied the most context is the one
 * whose window the meter must be honest about.
 */
function modelContextWindow(ev: Record<string, unknown>): number | undefined {
  const models = record(ev.modelUsage)
  if (!models) return undefined
  let best: { occupied: number; window: number } | undefined
  for (const key of Object.keys(models)) {
    const m = record(models[key])
    if (!m) continue
    const window = pickNumber(m, CONTEXT_WINDOW_KEYS)
    if (window === undefined || window <= 0) continue
    const occupied =
      (pickNumber(m, INPUT_KEYS) ?? 0) +
      (pickNumber(m, CACHE_READ_KEYS) ?? 0) +
      (pickNumber(m, CACHE_CREATE_KEYS) ?? 0)
    if (!best || occupied > best.occupied) best = { occupied, window }
  }
  return best?.window
}

/**
 * Fold a turn into the session total. Later turns only ever add: a CLI that
 * stops reporting halfway must not shrink a number the user already saw.
 */
export function addUsage(total: SessionUsage | undefined, turn: TurnUsage): SessionUsage {
  const base: SessionUsage = total ?? { turns: 0 }
  const next: SessionUsage = { turns: base.turns + 1 }
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreateTokens",
    "costUsd",
    "durationMs",
  ] as const) {
    const sum = (base[key] ?? 0) + (turn[key] ?? 0)
    if (base[key] !== undefined || turn[key] !== undefined) next[key] = sum
  }
  const window = turn.contextWindow ?? base.contextWindow
  if (window !== undefined) next.contextWindow = window
  next.lastTurn = { ...turn }
  return next
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function pickNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const v = source[key]
    // Rejecting non-finite here matters: a CLI that prints `"cost": null` on a
    // cached turn would otherwise poison the running total with NaN.
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return undefined
}

function assign(
  out: TurnUsage,
  key: keyof TurnUsage,
  value: number | undefined,
): void {
  if (value !== undefined) out[key] = value
}
