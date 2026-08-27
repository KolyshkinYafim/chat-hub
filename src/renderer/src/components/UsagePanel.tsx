import { useMemo, useState, type ReactNode } from "react"
import type {
  SessionMeta,
  UsageLedgerEntry,
  UsageSummary,
  UsageWindowTotals,
} from "@shared/types"
import { formatTokens, formatUsd } from "../lib/usage"
import { formatRelative } from "../lib/format"
import {
  axisTicks,
  buildDaySeries,
  cacheStats,
  comparePeriods,
  dayKeysEnding,
  defaultMetric,
  formatAxisValue,
  formatDayFull,
  formatDayTick,
  formatDelta,
  formatMetric,
  formatPercent,
  formatUsdWide,
  groupEntries,
  metricValue,
  niceMax,
  OTHER_KEY,
  perTurn,
  RANGE_DAYS,
  sessionSpend,
  sumEntries,
  tickIndices,
  totalTokens,
  turnsLabel,
  type DaySeries,
  type RangeDays,
  type UsageGroup,
  type UsageMetric,
  type UsageSplit,
} from "../lib/usage-report"

/**
 * The Usage tab. Everything numeric comes from lib/usage-report; this file only
 * decides layout, colours and what the hover says.
 */

/** "a", "a and b", "a, b and c" — for naming a handful of series in prose. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/**
 * Series colours are theme tokens, never literals — four built-in themes plus a
 * custom theme editor repaint every one of them.
 */
const SERIES_TOKENS = [
  "--accent",
  "--ok",
  "--waiting",
  "--working",
  "--danger",
]

/** Series past this many are folded into "other", in the chart and the lists alike. */
const SERIES_KEYS = SERIES_TOKENS.length

function seriesColor(key: string, index: number): string {
  if (key === OTHER_KEY) return "var(--text-faint)"
  return `var(${SERIES_TOKENS[index % SERIES_TOKENS.length]})`
}

const CHART_W = 720
const CHART_H = 190
const PAD_TOP = 12
const PAD_RIGHT = 20
const PAD_BOTTOM = 22
const PAD_LEFT = 46
const PLOT_W = CHART_W - PAD_LEFT - PAD_RIGHT
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM

const TOP_SESSIONS = 6

/**
 * When the shown summary was loaded. Every day window is measured from here, so
 * a re-render — hovering a bar, flipping a switch — cannot slide "today" out
 * from under the chart mid-interaction.
 */
function anchorFor(_summary: UsageSummary | null): number {
  return Date.now()
}

type Props = {
  summary: UsageSummary | null
  loading: boolean
  sessions: SessionMeta[]
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (next: T) => void
}) {
  return (
    <div className="usage-seg" role="group" aria-label={label}>
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          className={`usage-seg-btn${opt.value === value ? " is-on" : ""}`}
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function DeltaNote({
  ratio,
  windowLabel,
}: {
  ratio: number | null
  windowLabel: string
}) {
  const text = formatDelta(ratio)
  if (text === null) {
    return <div className="usage-tile-delta">no earlier {windowLabel}</div>
  }
  if (ratio === null || text === "no change") {
    return <div className="usage-tile-delta">flat vs prev {windowLabel}</div>
  }
  const dir = ratio > 0 ? "up" : "down"
  return (
    <div className="usage-tile-delta">
      <span className={`usage-arrow is-${dir}`}>{ratio > 0 ? "↑" : "↓"}</span>{" "}
      {text.replace("-", "")} vs prev {windowLabel}
    </div>
  )
}

function UsageTile({
  label,
  value,
  sub,
  children,
}: {
  label: string
  value: string
  sub?: string
  children?: ReactNode
}) {
  return (
    <div className="usage-tile">
      <div className="usage-tile-label">{label}</div>
      <div className="usage-tile-cost">{value}</div>
      {sub ? <div className="usage-tile-sub">{sub}</div> : null}
      {children}
    </div>
  )
}

/** Stacked daily bars with a real axis; hover is owned by the caller. */
function UsageChart({
  series,
  hovered,
  onHover,
}: {
  series: DaySeries
  hovered: number | null
  onHover: (index: number | null) => void
}) {
  const top = niceMax(series.max)
  const ticks = axisTicks(series.max, 2)
  const slot = PLOT_W / Math.max(1, series.points.length)
  const barW = Math.max(1.5, Math.min(20, slot * 0.68))
  const yFor = (v: number): number => PAD_TOP + PLOT_H - (v / top) * PLOT_H
  const labelAt = new Set(
    tickIndices(series.points.length, series.points.length <= 14 ? 7 : 6),
  )
  return (
    <svg
      className="usage-chart-svg"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      role="img"
      aria-label={`Daily usage over the last ${series.points.length} days`}
      onMouseLeave={() => onHover(null)}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line
            className="usage-chart-grid"
            x1={PAD_LEFT}
            x2={CHART_W - PAD_RIGHT}
            y1={yFor(t)}
            y2={yFor(t)}
          />
          <text
            className="usage-chart-axis"
            x={PAD_LEFT - 8}
            y={yFor(t)}
            textAnchor="end"
            dominantBaseline="middle"
          >
            {formatAxisValue(t, series.metric)}
          </text>
        </g>
      ))}
      {series.points.map((point, i) => {
        const x = PAD_LEFT + slot * i
        let acc = 0
        return (
          <g key={point.day}>
            {hovered === i ? (
              <rect
                className="usage-chart-hover"
                x={x}
                y={PAD_TOP}
                width={slot}
                height={PLOT_H}
              />
            ) : null}
            {point.slices.map((slice, si) => {
              if (slice.value <= 0) return null
              const h = Math.max(1, (slice.value / top) * PLOT_H)
              const y = yFor(acc) - h
              acc += slice.value
              return (
                <rect
                  key={slice.key}
                  x={x + (slot - barW) / 2}
                  y={y}
                  width={barW}
                  height={h}
                  fill={seriesColor(slice.key, si)}
                  rx={barW > 5 ? 1.5 : 0}
                />
              )
            })}
            {labelAt.has(i) ? (
              <text
                className="usage-chart-axis"
                x={x + slot / 2}
                y={CHART_H - 6}
                textAnchor="middle"
              >
                {formatDayTick(point.day)}
              </text>
            ) : null}
            <rect
              x={x}
              y={PAD_TOP}
              width={slot}
              height={PLOT_H}
              fill="transparent"
              onMouseEnter={() => onHover(i)}
            >
              <title>{`${formatDayFull(point.day)} · ${formatMetric(
                point.total,
                series.metric,
              )} · ${turnsLabel(point.turns)}`}</title>
            </rect>
          </g>
        )
      })}
      <line
        className="usage-chart-axis-line"
        x1={PAD_LEFT}
        x2={CHART_W - PAD_RIGHT}
        y1={PAD_TOP + PLOT_H}
        y2={PAD_TOP + PLOT_H}
      />
    </svg>
  )
}

/**
 * `keyed` tints the bars with the chart's series colours — true only for the
 * list the chart is currently split by, so one colour never means two things.
 */
function BreakdownList({
  title,
  groups,
  metric,
  keyed,
}: {
  title: string
  groups: UsageGroup[]
  metric: UsageMetric
  keyed: boolean
}) {
  const max = Math.max(...groups.map((g) => metricValue(g, metric)), 1e-9)
  return (
    <div>
      <h3 className="usage-sub-label">{title}</h3>
      {groups.map((g, i) => (
        <div
          key={g.label}
          className="usage-bar-row"
          title={`${turnsLabel(g.turns)} · ${formatUsd(g.costUsd)} · ${formatTokens(
            totalTokens(g),
          )} tok`}
        >
          <span className="usage-bar-label">{g.label}</span>
          <span className="usage-bar-track">
            <span
              className="usage-bar-fill"
              style={{
                // A zero row keeps its label but draws no stub — a 2px bar on
                // "$0.00" reads as "a little", which is the opposite of true.
                width:
                  metricValue(g, metric) > 0
                    ? `${Math.max(2, (metricValue(g, metric) / max) * 100)}%`
                    : 0,
                background: keyed ? seriesColor(g.label, i) : undefined,
              }}
            />
          </span>
          <span className="usage-bar-value">
            {formatMetric(metricValue(g, metric), metric)}
          </span>
        </div>
      ))}
    </div>
  )
}

function CacheCard({ totals }: { totals: UsageWindowTotals }) {
  const stats = cacheStats(totals)
  if (!stats) return null
  return (
    <div className="usage-card">
      <div className="usage-card-head">
        <h3 className="usage-sub-label">Cache efficiency</h3>
        <span className="usage-card-note">
          {formatPercent(stats.hitRatio)} of prompt tokens came from cache
        </span>
      </div>
      <div
        className="usage-cache-bar"
        title={`${formatTokens(stats.cacheReadTokens)} cached · ${formatTokens(
          stats.freshInputTokens,
        )} fresh`}
      >
        <span
          className="usage-cache-seg is-cached"
          style={{ width: `${stats.hitRatio * 100}%` }}
        />
      </div>
      <div className="usage-cache-legend">
        <span>
          <span className="usage-dot" style={{ background: "var(--ok)" }} />
          cached {formatTokens(stats.cacheReadTokens)}
        </span>
        <span>
          <span
            className="usage-dot"
            style={{ background: "var(--border-strong)" }}
          />
          fresh input {formatTokens(stats.freshInputTokens)}
        </span>
        <span>
          cache writes {formatTokens(stats.cacheCreateTokens)}
        </span>
      </div>
    </div>
  )
}

function TopSessions({
  entries,
  days,
  sessions,
  rangeLabel,
}: {
  entries: UsageLedgerEntry[]
  days: readonly string[]
  sessions: SessionMeta[]
  rangeLabel: string
}) {
  const { rows, unattributed } = useMemo(
    () => sessionSpend(entries, days, sessions, TOP_SESSIONS),
    [entries, days, sessions],
  )
  const orphaned = unattributed.costUsd > 0 || totalTokens(unattributed) > 0
  if (rows.length === 0 && !orphaned) return null
  return (
    <div className="usage-card">
      <div className="usage-card-head">
        <h3 className="usage-sub-label">Top sessions</h3>
        <span className="usage-card-note">{rangeLabel}</span>
      </div>
      <div className="usage-table">
        <div className="usage-table-row is-head">
          <span>Session</span>
          <span>Share</span>
          <span className="usage-num">Cost</span>
          <span className="usage-num">Tokens</span>
          <span className="usage-num">Turns</span>
          <span className="usage-num">Last used</span>
        </div>
        {rows.map((row) => (
          <div key={row.id} className="usage-table-row">
            <span className="usage-table-name">
              <span className="usage-table-title">{row.title}</span>
              <span className="usage-table-meta">
                {row.project} · {row.provider}
                {row.model ? ` · ${row.model}` : ""}
              </span>
            </span>
            <span className="usage-bar-track" title={formatPercent(row.share)}>
              <span
                className="usage-bar-fill"
                style={{ width: `${Math.max(2, row.share * 100)}%` }}
              />
            </span>
            <span className="usage-num">
              {row.costUsd > 0 ? formatUsd(row.costUsd) : "—"}
            </span>
            <span className="usage-num">{formatTokens(row.tokens)}</span>
            <span className="usage-num">{row.turns}</span>
            <span className="usage-num usage-dim">
              {formatRelative(row.updatedAt)}
            </span>
          </div>
        ))}
      </div>
      {orphaned ? (
        <p className="usage-card-foot">
          {formatUsdWide(unattributed.costUsd)} ·{" "}
          {formatTokens(totalTokens(unattributed))} tok in this range belongs to
          no live session — turns recorded before spend was tracked per session,
          and sessions since deleted.
        </p>
      ) : null}
    </div>
  )
}

export function UsagePanel({ summary, loading, sessions }: Props) {
  const [range, setRange] = useState<RangeDays>(30)
  const [split, setSplit] = useState<UsageSplit>("provider")
  const [metric, setMetric] = useState<UsageMetric | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)

  const entries = useMemo(() => summary?.entries ?? [], [summary])
  // Falls back to tokens for CLIs that never report a cost, so their bars exist.
  const shown = metric ?? defaultMetric(entries)
  const now = useMemo(() => anchorFor(summary), [summary])

  const series = useMemo(
    () => buildDaySeries(entries, now, range, split, shown, SERIES_KEYS),
    [entries, now, range, split, shown],
  )
  const comparison = useMemo(
    () => comparePeriods(entries, now, range),
    [entries, now, range],
  )
  const rangeDays = useMemo(() => dayKeysEnding(now, range), [now, range])
  const scoped = useMemo(() => {
    const days = new Set(rangeDays)
    return entries.filter((e) => days.has(e.day))
  }, [entries, rangeDays])
  const allTime = useMemo(() => sumEntries(entries), [entries])

  if (loading && !summary) {
    return (
      <div className="usage-loading">
        <span className="usage-skeleton is-tiles" />
        <span className="usage-skeleton is-chart" />
      </div>
    )
  }
  if (!summary || summary.entries.length === 0) {
    return (
      <p className="usage-empty">
        No usage recorded yet — cost and token totals appear here after the
        first completed agent turn.
      </p>
    )
  }

  const rangeLabel = `${range} days`
  const windowLabel = `${range}d`
  const totals = comparison.current
  const avg = perTurn(totals)
  const cache = cacheStats(totals)
  const point = hovered === null ? null : (series.points[hovered] ?? null)

  return (
    <div className="usage-panel">
      <div className="usage-panel-head">
        <span className="usage-panel-range">Last {rangeLabel}</span>
        <Segmented
          label="Range"
          value={range}
          onChange={(next) => {
            setRange(next)
            setHovered(null)
          }}
          options={RANGE_DAYS.map((d) => ({ value: d, label: `${d}d` }))}
        />
      </div>

      <div className="usage-tiles">
        <UsageTile label="Spend" value={formatUsdWide(totals.costUsd)}>
          <DeltaNote ratio={comparison.costDelta} windowLabel={windowLabel} />
        </UsageTile>
        <UsageTile
          label="Tokens"
          value={`${formatTokens(totalTokens(totals))}`}
        >
          <DeltaNote ratio={comparison.tokenDelta} windowLabel={windowLabel} />
        </UsageTile>
        <UsageTile label="Turns" value={String(totals.turns)}>
          <DeltaNote ratio={comparison.turnDelta} windowLabel={windowLabel} />
        </UsageTile>
        <UsageTile
          label="Per turn"
          value={avg ? formatUsd(avg.costUsd) : "—"}
          sub={avg ? `${formatTokens(Math.round(avg.tokens))} tok / turn` : undefined}
        />
        {cache ? (
          <UsageTile
            label="Cache hits"
            value={formatPercent(cache.hitRatio)}
            sub={`${formatTokens(cache.cacheReadTokens)} of prompt tokens`}
          />
        ) : null}
      </div>

      <div className="usage-card">
        <div className="usage-card-head">
          <h3 className="usage-sub-label">
            Daily {shown === "cost" ? "spend" : "tokens"}
          </h3>
          <div className="usage-switches">
            <Segmented
              label="Metric"
              value={shown}
              onChange={setMetric}
              options={[
                { value: "cost", label: "Cost" },
                { value: "tokens", label: "Tokens" },
              ]}
            />
            <Segmented
              label="Split by"
              value={split}
              onChange={setSplit}
              options={[
                { value: "provider", label: "Provider" },
                { value: "model", label: "Model" },
              ]}
            />
          </div>
        </div>

        <div className="usage-readout">
          {point ? (
            <>
              <span className="usage-readout-day">
                {formatDayFull(point.day)}
              </span>
              <span className="usage-readout-main">
                {formatUsdWide(point.costUsd)}
              </span>
              <span className="usage-readout-sub">
                {formatTokens(totalTokens(point))} tok ·{" "}
                {turnsLabel(point.turns)}
                {point.cacheReadTokens > 0
                  ? ` · ${formatTokens(point.cacheReadTokens)} cached`
                  : ""}
              </span>
            </>
          ) : (
            <span className="usage-readout-sub">
              Hover a day for its cost, tokens and turns.
            </span>
          )}
        </div>

        {series.keys.length === 0 ? (
          <p className="usage-empty usage-chart-empty">
            Nothing recorded in the last {rangeLabel}.
          </p>
        ) : (
          <>
            <UsageChart
              series={series}
              hovered={hovered}
              onHover={setHovered}
            />
            <div className="usage-legend">
              {series.keys.map((key, i) => (
                <span key={key} className="usage-legend-item">
                  <span
                    className="usage-dot"
                    style={{ background: seriesColor(key, i) }}
                  />
                  {key}
                  {point ? (
                    <span className="usage-dim">
                      {" "}
                      {formatMetric(
                        point.slices[i]?.value ?? 0,
                        series.metric,
                      )}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
            {series.unpricedKeys.length > 0 ? (
              <p className="usage-chart-note">
                {joinNames(series.unpricedKeys)}{" "}
                {series.unpricedKeys.length === 1 ? "reports" : "report"} no{" "}
                {series.metric === "cost" ? "cost" : "tokens"} — switch to{" "}
                {series.metric === "cost" ? "tokens" : "cost"} to see the work
                {series.metric === "cost" ? " done" : " billed"}.
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="usage-breakdowns">
        <BreakdownList
          title={`By provider · ${rangeLabel}`}
          groups={groupEntries(scoped, "provider", SERIES_KEYS, shown)}
          metric={shown}
          keyed={split === "provider"}
        />
        <BreakdownList
          title={`By model · ${rangeLabel}`}
          groups={groupEntries(scoped, "model", SERIES_KEYS, shown)}
          metric={shown}
          keyed={split === "model"}
        />
      </div>

      <CacheCard totals={totals} />
      <TopSessions
        entries={entries}
        days={rangeDays}
        sessions={sessions}
        rangeLabel={`last ${rangeLabel}`}
      />

      <p className="usage-foot">
        All time: {formatUsdWide(allTime.costUsd)} ·{" "}
        {formatTokens(totalTokens(allTime))} tok · {turnsLabel(allTime.turns)}.
      </p>
    </div>
  )
}
