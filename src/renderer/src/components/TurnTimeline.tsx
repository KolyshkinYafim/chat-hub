import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { AgentTurnItem } from "@shared/types"
import { formatElapsed } from "../lib/live-step"
import {
  buildTurnTimeline,
  formatTiming,
  unfinishedLabel,
  type TimelineRow,
} from "../lib/turn-timeline"
import {
  buildTurnPhases,
  workPhaseLabel,
  type PhaseSegment,
} from "../lib/turn-phases"

/** Rows kept on screen before the list scrolls inside its own box. */
const VISIBLE_ROWS = 8

export type TurnTimelineProps = {
  items: AgentTurnItem[] | undefined
  /** The turn's own prose — the summary when the provider sent no reasoning. */
  content: string
  streaming: boolean
  /** Reveal the card belonging to a row. */
  onJump: (itemId: string) => void
}

/**
 * The turn's table of contents: which phases it went through, why it ran,
 * then every step in order. The phase rail on top is the part a reader can
 * take in without reading — "explored, edited, tests failed" — and clicking a
 * phase narrows the list to its steps. Its own
 * height is bounded — rows are a fixed height and the list scrolls inside
 * itself past `VISIBLE_ROWS` — so a turn in flight never reflows the
 * transcript underneath the reader.
 */
export function TurnTimeline({
  items,
  content,
  streaming,
  onJump,
}: TurnTimelineProps) {
  const timeline = useMemo(
    () => buildTurnTimeline(items, content),
    [items, content],
  )
  const { rows, reasoning, summary, activeIndex, done, total, failed } = timeline
  const phases = useMemo(() => buildTurnPhases(items), [items])
  const [expanded, setExpanded] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  // The segment the reader clicked open; the list narrows to its steps.
  const [picked, setPicked] = useState<number | null>(null)
  const listRef = useRef<HTMLOListElement>(null)

  const active = activeIndex === null ? null : (rows[activeIndex - 1] ?? null)
  const activeKey = active?.id ?? "idle"
  const pickedSegment =
    picked === null ? null : (phases.rail[picked] ?? null)
  const liveSegment =
    streaming && phases.activeIndex !== null
      ? (phases.segments[phases.activeIndex] ?? null)
      : null
  const shownRows = useMemo(() => {
    if (!pickedSegment) return rows
    const ids = new Set(pickedSegment.itemIds)
    return rows.filter((row) => ids.has(row.id))
  }, [rows, pickedSegment])
  // The thought worth reading: the one behind the picked segment, else the
  // newest — which is what the agent is thinking right now while it streams.
  const thought = pickedSegment?.thought ?? liveSegment?.thought ?? summary

  useEffect(() => {
    if (!streaming) return
    const startedAt = Date.now()
    setElapsedMs(0)
    const timer = window.setInterval(
      () => setElapsedMs(Date.now() - startedAt),
      1000,
    )
    return () => window.clearInterval(timer)
  }, [activeKey, streaming])

  // Follow the agent inside the list's own scrollbox. Never scrollIntoView:
  // that would walk up and move the transcript, which is the whole complaint.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !active) return
    const at = shownRows.findIndex((row) => row.id === active.id)
    const row = at === -1 ? null : list.children[at]
    if (!(row instanceof HTMLElement)) return
    const bottom = row.offsetTop + row.offsetHeight
    if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight
    } else if (row.offsetTop < list.scrollTop) {
      list.scrollTop = row.offsetTop
    }
  }, [active, expanded, shownRows])

  const stuck = unfinishedLabel(rows)
  const state = streaming ? "running" : failed > 0 ? "failed" : "completed"
  const nowLine = active
    ? [active.label, active.detail].filter(Boolean).join(" · ")
    : streaming
      ? "Preparing the next step"
      : `${total} ${total === 1 ? "step" : "steps"}`

  return (
    <section className={`turn-timeline is-${state}`}>
      {phases.rail.length > 0 ? (
        <div
          className="turn-phase-rail"
          role="group"
          aria-label={phases.overview ? "Phases, totalled" : "Phases in order"}
        >
          {phases.rail.map((segment, at) => (
            <PhaseChip
              key={`${at}-${segment.phase}`}
              segment={segment}
              live={streaming && at === phases.railActive}
              picked={at === picked}
              onPick={() => setPicked((current) => (current === at ? null : at))}
            />
          ))}
        </div>
      ) : null}

      <div className="turn-timeline-head">
        <span className={`activity-status status-${state}`} aria-hidden />
        <span className="turn-timeline-kicker">
          {streaming ? "Working now" : "This turn"}
        </span>
        <span
          className="turn-timeline-now"
          title={active?.server ?? undefined}
          aria-live={streaming ? "polite" : undefined}
        >
          {nowLine}
        </span>
        {streaming ? (
          <span className="turn-timeline-elapsed">{formatElapsed(elapsedMs)}</span>
        ) : null}
        {stuck ? <span className="turn-timeline-failed">{stuck}</span> : null}
        {total > 0 ? (
          <span className="turn-timeline-count">
            {done}/{total}
          </span>
        ) : null}
      </div>

      {thought ? (
        <button
          type="button"
          className={`turn-timeline-summary${summaryOpen ? " is-open" : ""}${
            liveSegment?.thought && !pickedSegment ? " is-live" : ""
          }`}
          title={summaryOpen ? "Clamp the summary" : "Read every thought so far"}
          aria-expanded={summaryOpen}
          onClick={() => setSummaryOpen((open) => !open)}
        >
          {summaryOpen && reasoning.length > 1 ? (
            <span className="turn-timeline-reasoning">
              {reasoning.map((text, at) => (
                <span key={`${at}-${text}`}>{text}</span>
              ))}
            </span>
          ) : (
            thought
          )}
        </button>
      ) : null}

      {shownRows.length > 0 ? (
        <ol
          className={`turn-timeline-list${expanded || pickedSegment ? " is-expanded" : ""}`}
          ref={listRef}
        >
          {shownRows.map((row) => (
            <Row key={row.id} row={row} onJump={onJump} />
          ))}
        </ol>
      ) : null}

      {pickedSegment ? (
        <button
          type="button"
          className="turn-timeline-more"
          onClick={() => setPicked(null)}
        >
          Show all {rows.length} steps
        </button>
      ) : rows.length > VISIBLE_ROWS ? (
        <button
          type="button"
          className="turn-timeline-more"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show fewer steps" : `Show all ${rows.length} steps`}
        </button>
      ) : null}
    </section>
  )
}

/**
 * One phase on the rail. The label already carries the count and, for a test
 * run, the verdict; the hover adds the time it took and the thought that led
 * into it, so the reader can skim the rail without opening anything.
 */
function PhaseChip({
  segment,
  live,
  picked,
  onPick,
}: {
  segment: PhaseSegment
  live: boolean
  picked: boolean
  onPick: () => void
}) {
  const verdict = segment.test?.result
  const tone =
    verdict === "fail" ? " is-fail" : verdict === "pass" ? " is-pass" : ""
  const timing = formatTiming(segment.durationMs ?? undefined)
  const title = [
    `${workPhaseLabel[segment.phase]} · ${segment.count} ${
      segment.count === 1 ? "step" : "steps"
    }`,
    timing,
    segment.thought,
  ]
    .filter(Boolean)
    .join("\n")
  return (
    <button
      type="button"
      className={`turn-phase phase-${segment.phase}${tone}${
        live ? " is-live" : ""
      }${picked ? " is-picked" : ""}`}
      title={title}
      aria-pressed={picked}
      onClick={onPick}
    >
      {live ? <span className="turn-phase-pulse" aria-hidden /> : null}
      {segment.label}
    </button>
  )
}

function Row({
  row,
  onJump,
}: {
  row: TimelineRow
  onJump: (itemId: string) => void
}) {
  return (
    <li className={`turn-timeline-row is-${row.status}`}>
      <button
        type="button"
        className="turn-timeline-row-btn"
        title={row.detailFull || row.label}
        onClick={() => onJump(row.id)}
      >
        <span className="turn-timeline-num">{row.index}</span>
        <span className={`activity-status status-${row.status}`} aria-hidden />
        <span className="turn-timeline-label">{row.label}</span>
        <span className="turn-timeline-detail">{row.detail}</span>
        <span className="turn-timeline-timing">{row.timing ?? ""}</span>
        <span className="turn-timeline-state">{row.state}</span>
      </button>
    </li>
  )
}
