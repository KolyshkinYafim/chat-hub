const SIDEBAR_KEY = "chat-hub.sidebar.width"

/**
 * The floor the two draggable edges exist to protect. Below this the transcript
 * loses the `--bubble-w` / `--prose-w` rhythm it is laid out around and turns
 * into a column of two-word lines.
 */
export const MIN_TRANSCRIPT_WIDTH = 420

/**
 * Sidebar bounds. The lower one is where a session row stops fitting its status
 * dot, title and relative timestamp on one line — narrower than that the rail
 * (84px) is the better answer, and the collapse button already offers it. The
 * upper one is where the list stops gaining anything: rows are one line of text
 * and the search field is already full width.
 */
export const MIN_SIDEBAR_WIDTH = 200
export const MAX_SIDEBAR_WIDTH = 420
export const DEFAULT_SIDEBAR_WIDTH = 268

/** The collapsed rail, fixed in `.app.sidebar-is-collapsed` — keep in step. */
export const RAIL_WIDTH = 84

/**
 * Below this the viewport is not a window anyone is looking at — it is a hidden
 * window, or one still laying out, and both report widths that would clamp every
 * column to its minimum. Fitting sits it out rather than acting on a lie.
 */
export const MIN_FIT_VIEWPORT = MIN_SIDEBAR_WIDTH + MIN_TRANSCRIPT_WIDTH

/** Arrow-key nudge, and the Shift-held coarse one. */
export const WIDTH_KEY_STEP = 16
export const WIDTH_KEY_STEP_LARGE = 64

export function clampSidebarWidth(
  px: number,
  viewportWidth: number,
  dockWidth = 0,
): number {
  const room = viewportWidth - MIN_TRANSCRIPT_WIDTH - dockWidth
  const upper = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, Math.round(room)),
  )
  return Math.min(upper, Math.max(MIN_SIDEBAR_WIDTH, Math.round(px)))
}

export function loadSidebarWidth(): number {
  const raw = localStorage.getItem(SIDEBAR_KEY)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsed))
}

export function saveSidebarWidth(px: number): void {
  localStorage.setItem(SIDEBAR_KEY, String(Math.round(px)))
}

export type WidthKeyCommand =
  | { kind: "delta"; px: number }
  | { kind: "min" }
  | { kind: "max" }
  | { kind: "reset" }

/**
 * The ARIA window-splitter keys. `growKey` is the arrow that widens the panel
 * this handle belongs to — the sidebar's handle is on its right edge so it
 * grows with ArrowRight, the dock's is on its left so it grows with ArrowLeft.
 */
export function widthKeyCommand(
  key: string,
  shiftKey: boolean,
  growKey: "ArrowLeft" | "ArrowRight",
): WidthKeyCommand | null {
  const step = shiftKey ? WIDTH_KEY_STEP_LARGE : WIDTH_KEY_STEP
  if (key === "ArrowLeft" || key === "ArrowRight") {
    return { kind: "delta", px: key === growKey ? step : -step }
  }
  if (key === "Home") return { kind: "min" }
  if (key === "End") return { kind: "max" }
  if (key === "Enter" || key === " ") return { kind: "reset" }
  return null
}
