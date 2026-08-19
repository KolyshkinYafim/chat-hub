import type {
  ChatMessage,
  QueuedMessage,
  SessionMeta,
  SessionStatus,
  SessionUsage,
} from "@shared/types"
import { buildTranscript } from "./tool-runs"
import { currentStep, type LiveStep } from "./live-step"

export type FleetRow = {
  id: string
  title: string
  provider: string
  model: string | null
  status: SessionStatus
  step: LiveStep | null
  updatedAt: number
  elapsedMs: number
  costUsd: number | null
  queuedCount: number
  settled: boolean
}

export type FleetGroup = {
  project: string
  rows: FleetRow[]
}

export type FleetCounts = {
  working: number
  waiting: number
  error: number
  idle: number
  settled: number
}

export type Fleet = {
  groups: FleetGroup[]
  counts: FleetCounts
  total: number
}

const STATUS_RANK: Record<SessionStatus, number> = {
  running: 0,
  waiting_input: 1,
  error: 2,
  idle: 3,
  done: 3,
}

function rowRank(row: FleetRow): number {
  return row.settled ? 4 : STATUS_RANK[row.status]
}

function liveTurn(
  session: SessionMeta,
  messages: ChatMessage[],
): { step: LiveStep; since: number } | null {
  if (session.status !== "running") return null
  const last = messages[messages.length - 1]
  if (!last || last.role !== "assistant" || last.streaming !== true) return null
  return {
    step: currentStep(buildTranscript(last.content, last.id).blocks),
    since: last.createdAt,
  }
}

function compareRows(a: FleetRow, b: FleetRow): number {
  const byRank = rowRank(a) - rowRank(b)
  if (byRank !== 0) return byRank
  return b.updatedAt - a.updatedAt
}

function compareGroups(a: FleetGroup, b: FleetGroup): number {
  const byRank = rowRank(a.rows[0]) - rowRank(b.rows[0])
  if (byRank !== 0) return byRank
  return b.rows[0].updatedAt - a.rows[0].updatedAt
}

/**
 * Everything the fleet panel shows, derived from App state: per-project groups
 * of unarchived sessions, each row carrying the live step of a still-streaming
 * turn, plus header counts. Running rows measure elapsed from the streaming
 * turn's start; everything else from the session's last update.
 */
export function buildFleet(
  sessions: SessionMeta[],
  messagesBySession: Record<string, ChatMessage[]>,
  usage: Record<string, SessionUsage>,
  queued: Record<string, QueuedMessage[]>,
  now: number,
): Fleet {
  const byProject = new Map<string, FleetRow[]>()
  const counts: FleetCounts = {
    working: 0,
    waiting: 0,
    error: 0,
    idle: 0,
    settled: 0,
  }
  let total = 0
  for (const session of sessions) {
    if (session.archived) continue
    total += 1
    const live = liveTurn(session, messagesBySession[session.id] ?? [])
    const settled = session.settledAt !== undefined
    const row: FleetRow = {
      id: session.id,
      title: session.title,
      provider: session.provider,
      model: session.model ?? null,
      status: session.status,
      step: live?.step ?? null,
      updatedAt: session.updatedAt,
      elapsedMs: Math.max(0, now - (live?.since ?? session.updatedAt)),
      costUsd: usage[session.id]?.costUsd ?? null,
      queuedCount: queued[session.id]?.length ?? 0,
      settled,
    }
    if (settled) counts.settled += 1
    else if (session.status === "running") counts.working += 1
    else if (session.status === "waiting_input") counts.waiting += 1
    else if (session.status === "error") counts.error += 1
    else counts.idle += 1
    const rows = byProject.get(session.project)
    if (rows) rows.push(row)
    else byProject.set(session.project, [row])
  }
  const groups = [...byProject.entries()].map(([project, rows]) => ({
    project,
    rows: rows.sort(compareRows),
  }))
  groups.sort(compareGroups)
  return { groups, counts, total }
}

/** Header line like "2 working · 1 waiting · 4 settled"; empty buckets vanish. */
export function fleetSummary(counts: FleetCounts): string {
  const parts: string[] = []
  if (counts.working > 0) parts.push(`${counts.working} working`)
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`)
  if (counts.error > 0) parts.push(`${counts.error} failed`)
  if (counts.idle > 0) parts.push(`${counts.idle} idle`)
  if (counts.settled > 0) parts.push(`${counts.settled} settled`)
  return parts.join(" · ")
}
