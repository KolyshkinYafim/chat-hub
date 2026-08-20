import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { AgentTurnItem } from "@shared/types"
import { formatElapsed } from "../lib/live-step"
import {
  buildTurnTimeline,
  unfinishedLabel,
  type TimelineRow,
} from "../lib/turn-timeline"

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
 * The turn's table of contents: why it ran, then every step in order. Its own
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
  const [expanded, setExpanded] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)
  const listRef = useRef<HTMLOListElement>(null)

  const active = activeIndex === null ? null : (rows[activeIndex - 1] ?? null)
  const activeKey = active?.id ?? "idle"

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
    if (!list || activeIndex === null) return
    const row = list.children[activeIndex - 1]
    if (!(row instanceof HTMLElement)) return
    const bottom = row.offsetTop + row.offsetHeight
    if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight
    } else if (row.offsetTop < list.scrollTop) {
      list.scrollTop = row.offsetTop
    }
  }, [activeIndex, expanded, rows.length])

  const stuck = unfinishedLabel(rows)
  const state = streaming ? "running" : failed > 0 ? "failed" : "completed"
  const nowLine = active
    ? [active.label, active.detail].filter(Boolean).join(" · ")
    : streaming
      ? "Preparing the next step"
      : `${total} ${total === 1 ? "step" : "steps"}`

  return (
    <section className={`turn-timeline is-${state}`}>
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

      {summary ? (
        <button
          type="button"
          className={`turn-timeline-summary${summaryOpen ? " is-open" : ""}`}
          title={summaryOpen ? "Clamp the summary" : "Read the whole summary"}
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
            summary
          )}
        </button>
      ) : null}

      {rows.length > 0 ? (
        <ol
          className={`turn-timeline-list${expanded ? " is-expanded" : ""}`}
          ref={listRef}
        >
          {rows.map((row) => (
            <Row key={row.id} row={row} onJump={onJump} />
          ))}
        </ol>
      ) : null}

      {rows.length > VISIBLE_ROWS ? (
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
