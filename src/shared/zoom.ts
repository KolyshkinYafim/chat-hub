/**
 * Shell zoom in Chromium's own units: `factor = 1.2 ** level`, 0 = 100%.
 *
 * The range is deliberately narrower than Chromium's 25%–500%. The window's
 * own `minWidth` is 900px, and the shell needs a sidebar, a transcript and a
 * dock inside that; past ~1.7x the three no longer fit, and below ~0.7x the
 * 13px base type stops being legible.
 */
export const DEFAULT_ZOOM_LEVEL = 0
export const MIN_ZOOM_LEVEL = -2
export const MAX_ZOOM_LEVEL = 3

export function clampZoomLevel(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_ZOOM_LEVEL
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, Math.round(level)))
}

/** One ⌘+ / ⌘− press away, clamped at the ends. */
export function nextZoomLevel(current: number, direction: 1 | -1): number {
  return clampZoomLevel(clampZoomLevel(current) + direction)
}

export function zoomFactor(level: number): number {
  return 1.2 ** clampZoomLevel(level)
}

/** "100%", "120%", … for the menu item that reports the current step. */
export function zoomPercentLabel(level: number): string {
  return `${Math.round(zoomFactor(level) * 100)}%`
}
