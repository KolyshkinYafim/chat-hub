import type {
  SessionMeta,
  UsageLedgerEntry,
  UsageWindowTotals,
} from "@shared/types"
import { dayKey } from "@shared/day"
import { formatTokens } from "@shared/context-window"

/**
 * Aggregation behind the Usage tab. The ledger is one row per day × provider ×
 * model × session; everything the page shows — daily series, period comparison,
 * cache ratio, per-session spend — is derived here so the component only lays
 * it out.
 */

export type UsageMetric = "cost" | "tokens"
export type UsageSplit = "provider" | "model"

export const RANGE_DAYS = [14, 30, 90] as const
export type RangeDays = (typeof RANGE_DAYS)[number]

/** A totals row carrying the label it was grouped under. */
export type UsageGroup = UsageWindowTotals & { label: string }

/** One stacked segment of a day, keyed by provider or model. */
export type DaySlice = { key: string; value: number }

export type DayPoint = UsageWindowTotals & {
  day: string
  /** Segments in `DaySeries.keys` order, so colours stay put across days. */
  slices: DaySlice[]
  total: number
}

export type DaySeries = {
  points: DayPoint[]
  /** Legend order: biggest contributors first, overflow folded into "other". */
  keys: string[]
  /** Largest daily total in the chosen metric; 0 when the range is empty. */
  max: number
  metric: UsageMetric
  /**
   * Keys that did work in this range but reported no cost for it. They keep
   * their legend entry at $0.00 rather than disappearing from a cost chart,
   * which is what once made a provider with millions of tokens look unused.
   */
  unpricedKeys: string[]
}

export const OTHER_KEY = "other"

export function emptyTotals(): UsageWindowTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    turns: 0,
  }
}

function addEntry(into: UsageWindowTotals, e: UsageLedgerEntry): void {
  into.inputTokens += e.inputTokens
  into.outputTokens += e.outputTokens
  into.cacheReadTokens += e.cacheReadTokens
  into.cacheCreateTokens += e.cacheCreateTokens
  into.costUsd += e.costUsd
  into.turns += e.turns
}

/** Billable tokens — cache reads are counted separately, never here. */
export function totalTokens(totals: UsageWindowTotals): number {
  return totals.inputTokens + totals.outputTokens
}

export function metricValue(
  totals: UsageWindowTotals,
  metric: UsageMetric,
): number {
  return metric === "cost" ? totals.costUsd : totalTokens(totals)
}

/** Cost only reads as a metric when someone actually reported one. */
export function defaultMetric(entries: UsageLedgerEntry[]): UsageMetric {
  return entries.some((e) => e.costUsd > 0) ? "cost" : "tokens"
}

export function splitKey(e: UsageLedgerEntry, split: UsageSplit): string {
  return split === "provider" ? e.provider : e.model
}

/**
 * The last `days` calendar days ending today, oldest first. Walks the calendar
 * instead of subtracting 24h so a DST boundary cannot drop or repeat a day.
 */
export function dayKeysEnding(now: number, days: number): string[] {
  const anchor = new Date(now)
  anchor.setHours(12, 0, 0, 0)
  const out: string[] = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const at = new Date(anchor)
    at.setDate(at.getDate() - i)
    out.push(dayKey(at.getTime()))
  }
  return out
}

/** The equal-length window sitting immediately before `dayKeysEnding`. */
export function previousDayKeys(now: number, days: number): string[] {
  const anchor = new Date(now)
  anchor.setHours(12, 0, 0, 0)
  anchor.setDate(anchor.getDate() - days)
  return dayKeysEnding(anchor.getTime(), days)
}

/** Every entry, no window — the all-time footer. */
export function sumEntries(entries: UsageLedgerEntry[]): UsageWindowTotals {
  const out = emptyTotals()
  for (const e of entries) addEntry(out, e)
  return out
}

export function totalsForDays(
  entries: UsageLedgerEntry[],
  days: readonly string[],
): UsageWindowTotals {
  const wanted = new Set(days)
  const out = emptyTotals()
  for (const e of entries) {
    if (wanted.has(e.day)) addEntry(out, e)
  }
  return out
}

/** Sums entries per key, biggest first; overflow past `limit` becomes "other". */
export function groupEntries(
  entries: UsageLedgerEntry[],
  split: UsageSplit,
  limit: number,
  metric: UsageMetric,
): UsageGroup[] {
  const map = new Map<string, UsageGroup>()
  for (const e of entries) {
    const label = splitKey(e, split)
    const g = map.get(label) ?? { label, ...emptyTotals() }
    addEntry(g, e)
    map.set(label, g)
  }
  const groups = [...map.values()].sort(
    (a, b) => metricValue(b, metric) - metricValue(a, metric),
  )
  if (groups.length <= limit) return groups
  const other: UsageGroup = { label: OTHER_KEY, ...emptyTotals() }
  for (const g of groups.slice(limit)) {
    other.inputTokens += g.inputTokens
    other.outputTokens += g.outputTokens
    other.cacheReadTokens += g.cacheReadTokens
    other.cacheCreateTokens += g.cacheCreateTokens
    other.costUsd += g.costUsd
    other.turns += g.turns
  }
  return [...groups.slice(0, limit), other]
}

/**
 * A contiguous, zero-filled day series split into stacked segments. Days with
 * no usage stay in the array so the x-axis keeps a constant scale — a gap is
 * information, not a row to drop.
 */
export function buildDaySeries(
  entries: UsageLedgerEntry[],
  now: number,
  days: number,
  split: UsageSplit,
  metric: UsageMetric,
  maxKeys = 5,
): DaySeries {
  const dayList = dayKeysEnding(now, days)
  const inRange = new Set(dayList)
  const scoped = entries.filter((e) => inRange.has(e.day))
  const groups = groupEntries(scoped, split, maxKeys, metric).filter(hasActivity)
  const keys = groups.map((g) => g.label)
  const unpricedKeys = groups
    .filter((g) => metricValue(g, metric) === 0)
    .map((g) => g.label)
  const ranked = new Map(keys.map((k, i) => [k, i]))
  const overflow = keys.includes(OTHER_KEY) ? OTHER_KEY : null

  const byDay = new Map<string, DayPoint>()
  for (const day of dayList) {
    byDay.set(day, {
      day,
      ...emptyTotals(),
      slices: keys.map((key) => ({ key, value: 0 })),
      total: 0,
    })
  }
  for (const e of scoped) {
    const point = byDay.get(e.day)
    if (!point) continue
    addEntry(point, e)
    const label = splitKey(e, split)
    const idx = ranked.get(label) ?? (overflow ? ranked.get(overflow) : undefined)
    if (idx === undefined) continue
    const slice = point.slices[idx]
    if (slice) slice.value += metric === "cost" ? e.costUsd : e.inputTokens + e.outputTokens
  }

  const points = dayList.map((day) => {
    const point = byDay.get(day)!
    point.total = metricValue(point, metric)
    return point
  })
  return {
    points,
    keys,
    max: points.reduce((m, p) => Math.max(m, p.total), 0),
    metric,
    unpricedKeys,
  }
}

/** Did this group do anything at all, whatever the chosen metric says it cost? */
function hasActivity(totals: UsageWindowTotals): boolean {
  return totalTokens(totals) > 0 || totals.cacheReadTokens > 0 || totals.turns > 0
}

export type PeriodComparison = {
  current: UsageWindowTotals
  previous: UsageWindowTotals
  /** Signed change in the metric, or null when the earlier period was empty. */
  costDelta: number | null
  tokenDelta: number | null
  turnDelta: number | null
}

export function comparePeriods(
  entries: UsageLedgerEntry[],
  now: number,
  days: number,
): PeriodComparison {
  const current = totalsForDays(entries, dayKeysEnding(now, days))
  const previous = totalsForDays(entries, previousDayKeys(now, days))
  return {
    current,
    previous,
    costDelta: deltaRatio(current.costUsd, previous.costUsd),
    tokenDelta: deltaRatio(totalTokens(current), totalTokens(previous)),
    turnDelta: deltaRatio(current.turns, previous.turns),
  }
}

/** Relative change, or null when there is no baseline to divide by. */
export function deltaRatio(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return (current - previous) / previous
}

export type CacheStats = {
  cacheReadTokens: number
  cacheCreateTokens: number
  freshInputTokens: number
  /** Share of prompt tokens served from cache rather than sent fresh. */
  hitRatio: number
}

/** Null when nothing in the window reported cache counts, so the UI can hide it. */
export function cacheStats(totals: UsageWindowTotals): CacheStats | null {
  if (totals.cacheReadTokens === 0 && totals.cacheCreateTokens === 0) return null
  const prompt = totals.cacheReadTokens + totals.inputTokens
  return {
    cacheReadTokens: totals.cacheReadTokens,
    cacheCreateTokens: totals.cacheCreateTokens,
    freshInputTokens: totals.inputTokens,
    hitRatio: prompt > 0 ? totals.cacheReadTokens / prompt : 0,
  }
}

export type PerTurn = { costUsd: number; tokens: number }

export function perTurn(totals: UsageWindowTotals): PerTurn | null {
  if (totals.turns <= 0) return null
  return {
    costUsd: totals.costUsd / totals.turns,
    tokens: totalTokens(totals) / totals.turns,
  }
}

export type SessionSpend = {
  id: string
  title: string
  project: string
  provider: string
  model: string | null
  costUsd: number
  tokens: number
  cacheReadTokens: number
  turns: number
  updatedAt: number
  /** This session's share of every session's spend, 0–1. */
  share: number
}

export type SessionSpendReport = {
  rows: SessionSpend[]
  /**
   * Spend inside the range that no live session accounts for: rows written
   * before the ledger carried a session dimension, and sessions since deleted.
   * Reporting it is what keeps the table from quietly undercounting the range.
   */
  unattributed: UsageWindowTotals
}

/**
 * Per-session spend for one range, biggest first. Sessions the CLI never costed
 * rank by tokens instead, so a free-tier provider still appears.
 */
export function sessionSpend(
  entries: UsageLedgerEntry[],
  days: readonly string[],
  sessions: SessionMeta[],
  limit: number,
): SessionSpendReport {
  const wanted = new Set(days)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const totals = new Map<string, UsageWindowTotals>()
  const unattributed = emptyTotals()
  for (const e of entries) {
    if (!wanted.has(e.day)) continue
    const meta = e.sessionId ? byId.get(e.sessionId) : undefined
    if (!meta) {
      addEntry(unattributed, e)
      continue
    }
    const into = totals.get(meta.id) ?? emptyTotals()
    addEntry(into, e)
    totals.set(meta.id, into)
  }
  const rows: SessionSpend[] = []
  for (const [id, total] of totals) {
    const meta = byId.get(id)
    if (!meta || !hasActivity(total)) continue
    rows.push({
      id,
      title: meta.title,
      project: meta.project,
      provider: meta.provider,
      model: meta.model ?? null,
      costUsd: total.costUsd,
      tokens: totalTokens(total),
      cacheReadTokens: total.cacheReadTokens,
      turns: total.turns,
      updatedAt: meta.updatedAt,
      share: 0,
    })
  }
  return { rows: rankSpend(rows, limit), unattributed }
}

function rankSpend(rows: SessionSpend[], limit: number): SessionSpend[] {
  const useCost = rows.some((r) => r.costUsd > 0)
  const weight = (r: SessionSpend): number => (useCost ? r.costUsd : r.tokens)
  const pool = rows.reduce((sum, r) => sum + weight(r), 0)
  for (const r of rows) r.share = pool > 0 ? weight(r) / pool : 0
  return rows.sort((a, b) => weight(b) - weight(a)).slice(0, limit)
}

/** Rounds an axis top up to 1, 2 or 5 × a power of ten so ticks read cleanly. */
export function niceMax(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 1
  const base = 10 ** Math.floor(Math.log10(value))
  const n = value / base
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * base
}

/** Tick values from 0 to `max` inclusive, ascending. */
export function axisTicks(max: number, steps = 2): number[] {
  const top = niceMax(max)
  return Array.from({ length: steps + 1 }, (_, i) => (top / steps) * i)
}

/** Evenly spaced label slots that always include the first and last day. */
export function tickIndices(length: number, wanted: number): number[] {
  if (length <= 0) return []
  if (length <= wanted) return Array.from({ length }, (_, i) => i)
  const span = (length - 1) / (wanted - 1)
  const out = new Set<number>()
  for (let i = 0; i < wanted; i += 1) out.add(Math.round(i * span))
  return [...out].sort((a, b) => a - b)
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** "2026-08-04" → "Aug 4". Parsed by hand: `new Date(iso)` would shift zones. */
export function formatDayTick(day: string): string {
  const [year, month, date] = day.split("-")
  const label = MONTHS[Number(month) - 1]
  return label && year ? `${label} ${Number(date)}` : day
}

export function formatDayFull(day: string): string {
  const [year, month, date] = day.split("-")
  const label = MONTHS[Number(month) - 1]
  if (!label || !year) return day
  const at = new Date(Number(year), Number(month) - 1, Number(date))
  return `${WEEKDAYS[at.getDay()]}, ${label} ${Number(date)}`
}

/** Headline amounts get thousands separators; formatUsd stays for inline chips. */
export function formatUsdWide(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01"
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** Axis labels drop the cents that a gridline never needs. */
export function formatAxisValue(value: number, metric: UsageMetric): string {
  if (metric === "tokens") return formatTokens(Math.round(value))
  if (value === 0) return "$0"
  if (value < 1) return `$${value.toFixed(2)}`
  if (value < 10) return `$${value.toFixed(1)}`
  return `$${Math.round(value)}`
}

export function formatMetric(value: number, metric: UsageMetric): string {
  return metric === "cost"
    ? formatUsdWide(value)
    : `${formatTokens(Math.round(value))} tok`
}

/** "+42%" / "-13%", or null when there was no earlier period to compare with. */
export function formatDelta(ratio: number | null): string | null {
  if (ratio === null || !Number.isFinite(ratio)) return null
  const pct = ratio * 100
  const rounded =
    Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10
  if (rounded === 0) return "no change"
  return `${rounded > 0 ? "+" : ""}${rounded}%`
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export function turnsLabel(turns: number): string {
  return `${turns} ${turns === 1 ? "turn" : "turns"}`
}
