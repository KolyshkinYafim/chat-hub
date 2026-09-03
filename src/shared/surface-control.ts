/**
 * The contract for the agent-facing dock tools, which ride the same unix socket
 * and the same per-session env as the browser tools (see `./browser.ts`). Ops
 * are namespaced with a dot so one socket can carry both families and main can
 * route on the op alone; no browser op contains a dot.
 */

import type { BrowserResponse } from "./browser"
import type { SurfaceKind } from "./surfaces"

export const SURFACE_OP_PREFIX = "surface."

export const SURFACE_OPS = {
  open: "surface.open",
  close: "surface.close",
  status: "surface.status",
  script: "surface.script",
  boardAdd: "surface.board-add",
  boardCheck: "surface.board-check",
} as const

export type SurfaceOp = (typeof SURFACE_OPS)[keyof typeof SURFACE_OPS]

export function isSurfaceOp(op: string): boolean {
  return op.startsWith(SURFACE_OP_PREFIX)
}

/**
 * A socket request in the surface family. Deliberately wider than
 * `BrowserRequest` in `op` only: the browser union cannot name these ops, and
 * the router hands the request over before anything types it as a browser one.
 */
export type SurfaceRequest = {
  id: string
  sessionId: string
  op: string
  params: Record<string, unknown>
}

/** Same envelope as the browser ops — one socket, one response shape. */
export type SurfaceResponse = BrowserResponse

export type SurfaceHandler = (
  request: SurfaceRequest,
) => Promise<SurfaceResponse>

/**
 * Main telling the renderer to put a session's dock on a surface. The renderer
 * decides what is visible: it applies `path`/`line`/`command` and pulls the
 * dock open only when `sessionId` is the session on screen, so a call from a
 * background session records a choice without moving anything under the user.
 */
export type SurfaceOpenRequest = {
  sessionId: string
  /** `null` closes the dock and leaves the session's chosen surface alone. */
  surface: SurfaceKind | null
  /** Workspace-relative target for the diff, files and design surfaces. */
  path: string | null
  /** `path` is a folder to expand, not a file to open (files surface only). */
  directory: boolean
  /** 1-based line for the files surface. */
  line: number | null
  /** Named project script to run in the terminal surface. */
  command: string | null
  at: number
}

/**
 * The renderer's view of the dock, mirrored into main so a tool can answer
 * "what is open" without a round trip through a renderer that may be busy.
 */
export type SurfaceStateReport = {
  activeSessionId: string | null
  dockOpen: boolean
  surfaceBySession: Record<string, SurfaceKind>
}

export function emptySurfaceState(): SurfaceStateReport {
  return { activeSessionId: null, dockOpen: false, surfaceBySession: {} }
}
