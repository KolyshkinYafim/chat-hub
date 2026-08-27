import type { AgentTurnItem, TurnItemStatus } from "@shared/types"
import { describeItem, formatElapsed } from "./live-step"
import { looksLikePath, shortenPath } from "./short-path"

export type TimelineRow = {
  /** Position in the turn, 1-based — the number printed on the row. */
  index: number
  /** The item this row points at, so a click can reach its card. */
  id: string
  kind: AgentTurnItem["kind"]
  /** What ran: "Shell", "Edit", a tool name. */
  label: string
  /** On what: the command, the path, the query. Empty when there is no object. */
  detail: string
  /** `detail` before it was shortened — what a hover has to answer with. */
  detailFull: string
  status: TurnItemStatus
  /** One lower-case word for the row's right edge. */
  state: string
  /** Provider-reported duration, already formatted; null when unreported. */
  timing: string | null
  /** MCP server the tool came from, for the row's tooltip. */
  server: string | null
}

export type TurnTimeline = {
  rows: TimelineRow[]
  /** Every reasoning summary the provider sent, deduped, oldest first. */
  reasoning: string[]
  /** The newest reasoning, else the turn's own opening line. */
  summary: string
  /** 1-based row the agent is on; null once nothing is open. */
  activeIndex: number | null
  done: number
  total: number
  failed: number
}

const DETAIL_MAX = 140
/** A row is a fraction of the header's width, so a path gets far less than prose. */
const PATH_MAX = 52
const SUMMARY_MAX = 260

const STATE_WORDS: Record<TurnItemStatus, string> = {
  pending: "queued",
  running: "running",
  completed: "done",
  failed: "failed",
  declined: "declined",
  interrupted: "stopped",
}

/**
 * The ordered table of contents for one agent turn. Reasoning is lifted out of
 * the sequence into `summary` — it is the turn's "why", not one of its steps.
 */
export function buildTurnTimeline(
  items: AgentTurnItem[] | undefined,
  fallback = "",
): TurnTimeline {
  const all = items ?? []
  const steps = all.filter((item) => item.kind !== "reasoning")
  const rows = steps.map((item, at) => toRow(item, at + 1))
  const active =
    rows.find((row) => row.status === "running") ??
    rows.find((row) => row.status === "pending")
  const reasoning = [
    ...new Set(
      all
        .filter((item) => item.kind === "reasoning")
        .map((item) => cleanSummary(item.summary))
        .filter(Boolean),
    ),
  ]
  return {
    rows,
    reasoning,
    summary: clamp(
      reasoning[reasoning.length - 1] ?? cleanSummary(firstProseLine(fallback)),
      SUMMARY_MAX,
    ),
    activeIndex: active?.index ?? null,
    done: rows.filter((row) => row.status === "completed").length,
    total: rows.length,
    failed: rows.filter(
      (row) =>
        row.status === "failed" ||
        row.status === "declined" ||
        row.status === "interrupted",
    ).length,
  }
}

function toRow(item: AgentTurnItem, index: number): TimelineRow {
  const { label, detail, server } = describeItem(item)
  return {
    index,
    id: item.id,
    kind: item.kind,
    label,
    detail: looksLikePath(detail)
      ? shortenPath(detail, PATH_MAX)
      : clamp(detail, DETAIL_MAX),
    detailFull: detail,
    status: item.status,
    state: STATE_WORDS[item.status],
    timing: itemTiming(item),
    server,
  }
}

/**
 * A duration the Hub measured itself reads "~1.2s": it covers the whole time
 * the call was on the stream, which is not the same claim as a CLI's own timing.
 */
function itemTiming(item: AgentTurnItem): string | null {
  if (item.kind !== "command" && item.kind !== "tool") return null
  const timing = formatTiming(item.durationMs)
  if (!timing) return null
  return item.durationMeasured ? `~${timing}` : timing
}

/**
 * Row timings have to stay narrow and stop moving, so anything under ten
 * seconds is two significant figures rather than a growing clock.
 */
export function formatTiming(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return formatElapsed(ms)
}

/**
 * How to name the steps that did not finish. "Declined" and "failed" are not
 * the same thing to a reader, so the roll-up only says "failed" when that is
 * what every one of them was.
 */
export function unfinishedLabel(rows: TimelineRow[]): string | null {
  const stuck = rows.filter(
    (row) =>
      row.status === "failed" ||
      row.status === "declined" ||
      row.status === "interrupted",
  )
  if (stuck.length === 0) return null
  const words = new Set(stuck.map((row) => row.state))
  const word = words.size === 1 ? [...words][0]! : "unfinished"
  return `${stuck.length} ${word}`
}

/** Markdown emphasis reads as noise once the text is one clamped line. */
export function cleanSummary(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
}

function firstProseLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith("```")) return trimmed
  }
  return ""
}

function clamp(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}
