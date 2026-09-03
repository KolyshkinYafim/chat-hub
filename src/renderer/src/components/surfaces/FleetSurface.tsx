import { useEffect, useMemo, useState } from "react"
import type { QueuedMessage, SessionMeta, SessionUsage } from "@shared/types"
import { buildFleet, fleetSummary, type FleetRow } from "../../lib/fleet"
import type { AttentionSeen } from "../../lib/attention"
import { formatElapsed } from "../../lib/live-step"
import { formatRelative } from "../../lib/format"
import { formatUsd } from "../../lib/usage"
import { keyHint } from "../../lib/key-hint"
import { StatusDot } from "../StatusDot"

type Props = {
  sessions: SessionMeta[]
  usageBySession: Record<string, SessionUsage>
  queuedBySession: Record<string, QueuedMessage[]>
  attentionSeen: AttentionSeen
  activeSessionId: string
  onSelectSession: (id: string) => void
}

export function FleetSurface({
  sessions,
  usageBySession,
  queuedBySession,
  attentionSeen,
  activeSessionId,
  onSelectSession,
}: Props) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const fleet = useMemo(
    () =>
      buildFleet(sessions, usageBySession, queuedBySession, attentionSeen, now),
    [sessions, usageBySession, queuedBySession, attentionSeen, now],
  )

  if (fleet.total === 0) {
    return (
      <div className="fleet-empty">
        No sessions yet — agents you start will line up here.
        <span className="empty-hint">
          <span className="kbd">{keyHint("⌘N")}</span> new session
        </span>
      </div>
    )
  }

  return (
    <div className="fleet-surface">
      <div className="fleet-summary">{fleetSummary(fleet.counts)}</div>
      {fleet.sections.map((section) => (
        <section key={section.kind} className={`fleet-group ${section.kind}`}>
          <h3 className="fleet-group-name">{section.title}</h3>
          <div className="fleet-rows">
            {section.rows.map((row) => (
              <FleetRowButton
                key={row.id}
                row={row}
                now={now}
                active={row.id === activeSessionId}
                onSelect={onSelectSession}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function FleetRowButton({
  row,
  now,
  active,
  onSelect,
}: {
  row: FleetRow
  now: number
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      className={`fleet-row ${active ? "active" : ""} ${row.settled ? "settled" : ""}`}
      onClick={() => onSelect(row.id)}
    >
      <StatusDot
        status={row.status}
        attention={row.attention}
        phase={row.live?.phase ?? null}
      />
      <span className="fleet-row-body">
        <span className="fleet-row-head">
          <span className="fleet-row-title">{row.title}</span>
          <span className="fleet-row-chip">
            {row.project} · {row.provider}
            {row.model ? ` · ${row.model}` : ""}
          </span>
        </span>
        <span className="fleet-row-sub">
          {row.live ? (
            <>
              <span className={`orb ${row.live.phase}`} aria-hidden />
              <span className="fleet-step-label">{row.live.stepLabel}</span>
              {row.live.stepDetail ? (
                <span className="fleet-step-detail">· {row.live.stepDetail}</span>
              ) : null}
            </>
          ) : (
            <span className="fleet-row-when">
              updated {formatRelative(row.updatedAt, now)}
            </span>
          )}
        </span>
      </span>
      <span className="fleet-row-meta">
        {row.live ? (
          <span className="fleet-row-elapsed">{formatElapsed(row.elapsedMs)}</span>
        ) : null}
        {row.costUsd !== null ? (
          <span className="fleet-row-cost">{formatUsd(row.costUsd)}</span>
        ) : null}
        {row.queuedCount > 0 ? (
          <span className="fleet-row-queued">{row.queuedCount} queued</span>
        ) : null}
      </span>
    </button>
  )
}
