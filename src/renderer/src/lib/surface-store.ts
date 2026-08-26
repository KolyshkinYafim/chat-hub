import { isSurfaceKind } from "@shared/surfaces"
import { MIN_TRANSCRIPT_WIDTH } from "./shell-size"
import type { SurfaceKind } from "./surface-bridge"

const WIDTH_KEY = "chat-hub.surfaceDock.width"
const OPEN_KEY = "chat-hub.surfaceDock.open"
const BY_SESSION_KEY = "chat-hub.surfaceDock.bySession"
const AUTO_OPEN_KEY = "chat-hub.surfaceDock.autoOpen"

export { SURFACE_KINDS } from "@shared/surfaces"

export const MIN_DOCK_WIDTH = 320
export const DEFAULT_DOCK_WIDTH = 460

/**
 * The sidebar is part of the sum: without it a dock dragged to the viewport's
 * own limit leaves the transcript far under its floor on a narrow window.
 */
export function maxDockWidth(
  viewportWidth: number,
  sidebarWidth = 0,
): number {
  return Math.max(
    MIN_DOCK_WIDTH,
    Math.round(viewportWidth - MIN_TRANSCRIPT_WIDTH - sidebarWidth),
  )
}

export function clampDockWidth(
  px: number,
  viewportWidth: number,
  sidebarWidth = 0,
): number {
  const upper = maxDockWidth(viewportWidth, sidebarWidth)
  return Math.min(upper, Math.max(MIN_DOCK_WIDTH, Math.round(px)))
}

export function loadDockWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_DOCK_WIDTH
  return Math.max(MIN_DOCK_WIDTH, parsed)
}

export function saveDockWidth(px: number): void {
  localStorage.setItem(WIDTH_KEY, String(Math.round(px)))
}

export function loadDockOpen(): boolean {
  return localStorage.getItem(OPEN_KEY) === "1"
}

export function saveDockOpen(open: boolean): void {
  localStorage.setItem(OPEN_KEY, open ? "1" : "0")
}

export function loadSurfaceBySession(): Record<string, SurfaceKind> {
  const raw = localStorage.getItem(BY_SESSION_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return {}
    const out: Record<string, SurfaceKind> = {}
    for (const [sessionId, kind] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (isSurfaceKind(kind)) out[sessionId] = kind
    }
    return out
  } catch {
    return {}
  }
}

export function saveSurfaceBySession(map: Record<string, SurfaceKind>): void {
  localStorage.setItem(BY_SESSION_KEY, JSON.stringify(map))
}

/** Escape hatch for the auto-open-diff-on-edit behavior; defaults to on. */
export function loadAutoOpenDock(): boolean {
  return localStorage.getItem(AUTO_OPEN_KEY) !== "0"
}

export function saveAutoOpenDock(enabled: boolean): void {
  localStorage.setItem(AUTO_OPEN_KEY, enabled ? "1" : "0")
}

/**
 * Whether a message that just edited files should pull the dock open to the
 * diff surface, and whether the panel is currently in a state where that's
 * appropriate to do without yanking the user off something unrelated.
 *
 * - Dock closed → open it to "diff".
 * - Dock open on "files" or "diff" → switch/refresh to "diff" (a no-op re-set
 *   when it's already "diff", but still lets the caller bump a refresh key).
 * - Dock open on "terminal"/"browser"/"board" → leave it alone (null).
 */
export function shouldAutoOpenDock(
  current: { showDock: boolean; activeSurface: SurfaceKind | null },
  editedFiles: string[],
  autoOpenEnabled = true,
): SurfaceKind | null {
  if (!autoOpenEnabled || editedFiles.length === 0) return null
  if (!current.showDock) return "diff"
  if (current.activeSurface === "files" || current.activeSurface === "diff") {
    return "diff"
  }
  return null
}
