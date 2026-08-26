import type { Project, SessionMeta } from "@shared/types"
import { projectFromCwd } from "@shared/project"
import { fuzzyScore } from "./fuzzy"

/**
 * A folder the Hub already knows about, ready to start a chat in. The app has
 * three sources for these — the pinned projects, the folder of the session on
 * screen, and every folder a past session ran in — and nearly every new chat
 * is in one of them, so the create dialog offers them instead of an empty path
 * field with a fake path in it.
 */
export type ProjectPick = {
  /** Absolute folder. Unique key of the pick. */
  cwd: string
  name: string
  /** Pinned in the sidebar rather than merely remembered. */
  pinned: boolean
  /** How many sessions have run here. */
  sessions: number
  /** Newest session activity here, 0 when the folder has never been used. */
  lastUsedAt: number
  /** The agent instance the newest session here used. */
  instanceId?: string
  /** The model that session ran on. */
  model?: string
}

/** Trailing separators and a trailing "/." make two names for one folder. */
function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim().replace(/\\/g, "/")
  const stripped = trimmed.replace(/\/+\.?$/, "")
  return stripped || trimmed
}

/**
 * The folder a session belongs to. An isolated session runs inside a worktree
 * of its repository; the repository is the project, and offering the worktree
 * path as somewhere to start a new chat would be wrong.
 */
function sessionFolder(session: SessionMeta): string {
  return normalizeCwd(session.baseCwd ?? session.cwd)
}

/**
 * Every known folder, best first: the folder you are looking at, then whatever
 * you touched most recently, then pinned projects you have not used yet.
 */
export function buildProjectPicks(
  projects: Project[],
  sessions: SessionMeta[],
  hintCwd?: string,
): ProjectPick[] {
  const byCwd = new Map<string, ProjectPick>()

  // The name a pinned project carries is the one the owner chose, so it is set
  // on creation and never overwritten by a session's group name afterwards.
  const ensure = (cwd: string, name?: string): ProjectPick => {
    const existing = byCwd.get(cwd)
    if (existing) return existing
    const pick: ProjectPick = {
      cwd,
      name: name?.trim() || projectFromCwd(cwd),
      pinned: false,
      sessions: 0,
      lastUsedAt: 0,
    }
    byCwd.set(cwd, pick)
    return pick
  }

  for (const project of projects) {
    const pick = ensure(normalizeCwd(project.cwd), project.name)
    pick.pinned = true
    // A pinned project with no sessions still has to sort somewhere, and the
    // day it was pinned is the only recency it has.
    pick.lastUsedAt = Math.max(pick.lastUsedAt, project.createdAt)
  }

  // Newest first, so the first session seen for a folder is the one to recall.
  const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const session of ordered) {
    const cwd = sessionFolder(session)
    if (!cwd) continue
    const pick = ensure(cwd, session.project)
    pick.sessions += 1
    if (pick.instanceId === undefined) {
      pick.instanceId = session.instanceId ?? session.provider
      pick.model = session.model
    }
    pick.lastUsedAt = Math.max(pick.lastUsedAt, session.updatedAt)
  }

  const hint = hintCwd ? normalizeCwd(hintCwd) : ""
  if (hint) ensure(hint)

  return [...byCwd.values()].sort((a, b) => {
    if (a.cwd === hint) return -1
    if (b.cwd === hint) return 1
    return b.lastUsedAt - a.lastUsedAt
  })
}

/**
 * Filter by the same ordered-subsequence match the ⌘K switcher uses, over both
 * the project name and its path, so "orb" and "code/orb" both land.
 */
export function filterPicks(picks: ProjectPick[], query: string): ProjectPick[] {
  const q = query.trim()
  if (!q) return picks
  const scored: { pick: ProjectPick; score: number; rank: number }[] = []
  picks.forEach((pick, rank) => {
    const name = fuzzyScore(q, pick.name)
    const path = fuzzyScore(q, pick.cwd)
    const score = Math.max(name ?? -1, path === null ? -1 : path - 2)
    if (score >= 0) scored.push({ pick, score, rank })
  })
  // Ties keep the recency order the unfiltered list was already in.
  scored.sort((a, b) => b.score - a.score || a.rank - b.rank)
  return scored.map((s) => s.pick)
}

/** What the newest session in this folder ran on, for pre-selecting the agent. */
export function recallFor(
  picks: ProjectPick[],
  cwd: string,
): { instanceId?: string; model?: string } {
  const pick = picks.find((p) => p.cwd === normalizeCwd(cwd))
  return { instanceId: pick?.instanceId, model: pick?.model }
}

/**
 * Where the highlight lands after a keyboard move. The list wraps, and an empty
 * list has nothing to highlight.
 */
export function moveHighlight(
  length: number,
  current: number,
  delta: number,
): number {
  if (length <= 0) return 0
  return (((current + delta) % length) + length) % length
}

/**
 * A typed path is only worth offering as its own row when it looks like one and
 * is not already in the list — otherwise the row is a duplicate of a pick.
 */
export function typedPathPick(
  picks: ProjectPick[],
  query: string,
): ProjectPick | null {
  const q = query.trim()
  if (!q.startsWith("/") && !q.startsWith("~")) return null
  const cwd = normalizeCwd(q)
  if (!cwd || cwd === "/" || picks.some((p) => p.cwd === cwd)) return null
  return { cwd, name: projectFromCwd(cwd), pinned: false, sessions: 0, lastUsedAt: 0 }
}

/** The agent to preselect: what this folder last used, else the hub default. */
export function preferredAgent(
  recalled: string | undefined,
  available: { instanceId: string }[],
  fallback: string,
): string {
  if (recalled && available.some((a) => a.instanceId === recalled)) return recalled
  if (available.some((a) => a.instanceId === fallback)) return fallback
  return available[0]?.instanceId ?? fallback
}
