import { useEffect, useMemo, useState } from "react"
import type {
  ChatMessage,
  QueuedMessage,
  SessionMeta,
  SessionUsage,
} from "@shared/types"
import { buildFleet, fleetSummary, type FleetRow } from "../../lib/fleet"
import { formatElapsed, stepPhase } from "../../lib/live-step"
import { formatRelative } from "../../lib/format"
import { formatUsd } from "../../lib/usage"
import { StatusDot } from "../StatusDot"

type Props = {
  sessions: SessionMeta[]
  messagesBySession: Record<string, ChatMessage[]>
  usageBySession: Record<string, SessionUsage>
  queuedBySession: Record<string, QueuedMessage[]>
  activeSessionId: string
  onSelectSession: (id: string) => void
}

export function FleetSurface({
  sessions,
  messagesBySession,
  usageBySession,
  queuedBySession,
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
      buildFleet(sessions, messagesBySession, usageBySession, queuedBySession, now),
    [sessions, messagesBySession, usageBySession, queuedBySession, now],
  )

  if (fleet.total === 0) {
    return (
      <div className="fleet-empty">
        No sessions yet — agents you start will line up here.
        <span className="empty-hint">
          <span className="kbd">⌘N</span> new session
        </span>
      </div>
    )
  }

  return (
    <div className="fleet-surface">
      <div className="fleet-summary">{fleetSummary(fleet.counts)}</div>
      {fleet.groups.map((group) => (
        <section key={group.project} className="fleet-group">
          <h3 className="fleet-group-name">{group.project}</h3>
          <div className="fleet-rows">
            {group.rows.map((row) => (
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
      <StatusDot status={row.status} attention={row.attention} />
      <span className="fleet-row-body">
        <span className="fleet-row-head">
          <span className="fleet-row-title">{row.title}</span>
          <span className="fleet-row-chip">
            {row.provider}
            {row.model ? ` · ${row.model}` : ""}
          </span>
        </span>
        <span className="fleet-row-sub">
          {row.step ? (
            <>
              <span className={`orb ${stepPhase(row.step)}`} aria-hidden />
              <span className="fleet-step-label">{row.step.label}</span>
              {row.step.detail ? (
                <span className="fleet-step-detail">· {row.step.detail}</span>
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
        {row.step ? (
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
