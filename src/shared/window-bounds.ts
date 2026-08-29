/** A rectangle in screen coordinates — Electron's `Rectangle` shape. */
export type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

/** The usable area of one display, i.e. Electron's `Display.workArea`. */
export type WorkArea = WindowBounds

/** What the last run left behind, as it is written to settings.json. */
export type WindowState = {
  bounds: WindowBounds
  maximized: boolean
}

export const DEFAULT_WINDOW_WIDTH = 1280
export const DEFAULT_WINDOW_HEIGHT = 840
export const MIN_WINDOW_WIDTH = 900
export const MIN_WINDOW_HEIGHT = 600

/**
 * How much of the frame has to land on a screen before the saved position is
 * worth keeping. A window peeking in by a sliver is one the user cannot grab,
 * so it gets re-centered rather than nudged.
 */
const MIN_VISIBLE_WIDTH = 120
const MIN_VISIBLE_HEIGHT = 80

/** Stand-in when the caller has no display list at all (tests, headless). */
const FALLBACK_AREA: WorkArea = {
  x: 0,
  y: 0,
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
}

/** Reads back geometry written by an older (or hand-edited) settings.json. */
export function parseWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== "object") return null
  const outer = raw as { bounds?: unknown; maximized?: unknown }
  if (!outer.bounds || typeof outer.bounds !== "object") return null
  const b = outer.bounds as Record<string, unknown>
  const nums = [b.x, b.y, b.width, b.height]
  if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return null
  }
  const width = Math.round(b.width as number)
  const height = Math.round(b.height as number)
  if (width <= 0 || height <= 0) return null
  return {
    bounds: {
      x: Math.round(b.x as number),
      y: Math.round(b.y as number),
      width,
      height,
    },
    maximized: outer.maximized === true,
  }
}

/** One window's geometry, tagged with the id its renderer keys its layout by. */
export type PersistedWindow = WindowState & { windowId: number }

/** A window the launch path is about to open; no state means "first launch". */
export type OpeningWindow = { windowId: number; state: WindowState | null }

/**
 * Reads back the window list. Rows that no longer parse are dropped one by one
 * rather than failing the list, so one corrupt entry cannot cost the user every
 * other window's geometry.
 */
export function parseWindowStates(raw: unknown): PersistedWindow[] | null {
  if (!Array.isArray(raw)) return null
  const out: PersistedWindow[] = []
  const seen = new Set<number>()
  for (const row of raw) {
    const id = (row as { windowId?: unknown } | null)?.windowId
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) continue
    if (seen.has(id)) continue
    const state = parseWindowState(row)
    if (!state) continue
    seen.add(id)
    out.push({ windowId: id, ...state })
  }
  if (out.length === 0) return null
  return out.sort((a, b) => a.windowId - b.windowId)
}

/**
 * What a launch opens. The saved set is reopened as it stood, because closing a
 * window is how the user says they no longer want it. An empty or unreadable
 * list still yields window 1 — the app never comes up with nothing, and window 1
 * is the one whose panes live under the pre-multiwindow storage keys.
 */
export function windowsToReopen(
  saved: readonly PersistedWindow[] | null,
): OpeningWindow[] {
  if (!saved || saved.length === 0) return [{ windowId: 1, state: null }]
  return saved.map(({ windowId, ...state }) => ({ windowId, state }))
}

type Overlap = { width: number; height: number }

function overlap(a: WindowBounds, b: WorkArea): Overlap {
  return {
    width: Math.max(
      0,
      Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    ),
    height: Math.max(
      0,
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
    ),
  }
}

function pin(value: number, low: number, high: number): number {
  // `high` can fall below `low` when the frame is wider than the screen; the
  // screen's own origin wins there rather than an inverted range.
  return Math.max(low, Math.min(value, Math.max(low, high)))
}

/**
 * Refit saved geometry to the displays attached right now. `areas` is ordered
 * with the primary display first — that is where a window whose screen went
 * away comes back.
 *
 * Three cases, in order: a frame larger than its screen is shrunk to fit, a
 * frame hanging off an edge is slid back on, and a frame with no screen left
 * under it is centered on the primary.
 */
export function fitBoundsToWorkAreas(
  bounds: WindowBounds,
  areas: readonly WorkArea[],
): WindowBounds {
  const screens = areas.length > 0 ? areas : [FALLBACK_AREA]
  const host = screens.reduce((best, area) => {
    const a = overlap(bounds, area)
    const b = overlap(bounds, best)
    return a.width * a.height > b.width * b.height ? area : best
  }, screens[0])

  const width = Math.max(
    MIN_WINDOW_WIDTH,
    Math.min(Math.round(bounds.width), host.width),
  )
  const height = Math.max(
    MIN_WINDOW_HEIGHT,
    Math.min(Math.round(bounds.height), host.height),
  )

  const seen = overlap(bounds, host)
  if (seen.width < MIN_VISIBLE_WIDTH || seen.height < MIN_VISIBLE_HEIGHT) {
    return {
      x: host.x + Math.round((host.width - width) / 2),
      y: host.y + Math.round((host.height - height) / 2),
      width,
      height,
    }
  }

  return {
    x: pin(Math.round(bounds.x), host.x, host.x + host.width - width),
    y: pin(Math.round(bounds.y), host.y, host.y + host.height - height),
    width,
    height,
  }
}
