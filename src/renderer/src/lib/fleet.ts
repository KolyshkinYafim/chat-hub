import type {
  QueuedMessage,
  SessionLiveActivity,
  SessionMeta,
  SessionStatus,
  SessionUsage,
} from "@shared/types"
import { activityStamp, needsAction, STATUS_RANK } from "@shared/attention"
import { isUnseenDone, type AttentionSeen } from "./attention"

export type FleetRow = {
  id: string
  title: string
  project: string
  provider: string
  model: string | null
  status: SessionStatus
  live: SessionLiveActivity | null
  updatedAt: number
  elapsedMs: number
  costUsd: number | null
  queuedCount: number
  settled: boolean
  attention: boolean
}

export type FleetSectionKind =
  | "attention"
  | "working"
  | "review"
  | "idle"
  | "settled"

export type FleetSection = {
  kind: FleetSectionKind
  title: string
  rows: FleetRow[]
}

export type FleetCounts = Record<FleetSectionKind, number>

export type Fleet = {
  sections: FleetSection[]
  counts: FleetCounts
  total: number
}

const SECTION_ORDER: FleetSectionKind[] = [
  "attention",
  "working",
  "review",
  "idle",
  "settled",
]

const SECTION_TITLES: Record<FleetSectionKind, string> = {
  attention: "Needs attention",
  working: "Working",
  review: "To review",
  idle: "Idle",
  settled: "Settled",
}

export function fleetSection(
  session: SessionMeta,
  seen: AttentionSeen,
): FleetSectionKind {
  if (needsAction(session)) return "attention"
  if (session.status === "running" && session.settledAt === undefined) {
    return "working"
  }
  if (isUnseenDone(session, seen)) return "review"
  if (session.settledAt !== undefined) return "settled"
  return "idle"
}

function compareRows(
  kind: FleetSectionKind,
): (a: FleetRow, b: FleetRow) => number {
  if (kind === "attention") {
    return (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.updatedAt - b.updatedAt
  }
  if (kind === "working") {
    return (a, b) => b.elapsedMs - a.elapsedMs
  }
  return (a, b) => b.updatedAt - a.updatedAt
}

export function buildFleet(
  sessions: SessionMeta[],
  usage: Record<string, SessionUsage>,
  queued: Record<string, QueuedMessage[]>,
  seen: AttentionSeen,
  now: number,
): Fleet {
  const byKind = new Map<FleetSectionKind, FleetRow[]>()
  const counts: FleetCounts = {
    attention: 0,
    working: 0,
    review: 0,
    idle: 0,
    settled: 0,
  }
  let total = 0
  for (const session of sessions) {
    if (session.archived) continue
    total += 1
    const kind = fleetSection(session, seen)
    const live = session.status === "running" ? (session.live ?? null) : null
    const row: FleetRow = {
      id: session.id,
      title: session.title,
      project: session.project,
      provider: session.provider,
      model: session.model ?? null,
      status: session.status,
      live,
      updatedAt: activityStamp(session),
      elapsedMs: Math.max(0, now - (live?.startedAt ?? activityStamp(session))),
      costUsd: usage[session.id]?.costUsd ?? null,
      queuedCount: queued[session.id]?.length ?? 0,
      settled: session.settledAt !== undefined,
      attention: needsAction(session),
    }
    counts[kind] += 1
    const rows = byKind.get(kind)
    if (rows) rows.push(row)
    else byKind.set(kind, [row])
  }
  const sections: FleetSection[] = []
  for (const kind of SECTION_ORDER) {
    const rows = byKind.get(kind)
    if (!rows) continue
    sections.push({
      kind,
      title: SECTION_TITLES[kind],
      rows: rows.sort(compareRows(kind)),
    })
  }
  return { sections, counts, total }
}

export function fleetSummary(counts: FleetCounts): string {
  const parts: string[] = []
  if (counts.attention > 0) {
    parts.push(
      `${counts.attention} ${counts.attention === 1 ? "needs" : "need"} attention`,
    )
  }
  if (counts.working > 0) parts.push(`${counts.working} working`)
  if (counts.review > 0) parts.push(`${counts.review} to review`)
  if (counts.idle > 0) parts.push(`${counts.idle} idle`)
  if (counts.settled > 0) parts.push(`${counts.settled} settled`)
  return parts.join(" · ")
}
