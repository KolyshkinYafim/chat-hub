import { screen, type BrowserWindow, type WebContents } from "electron"
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  fitBoundsToWorkAreas,
  type WindowBounds,
  type WindowState,
  type WorkArea,
} from "@shared/window-bounds"
import {
  clampZoomLevel,
  DEFAULT_ZOOM_LEVEL,
  nextZoomLevel,
  zoomFactor,
} from "@shared/zoom"

/** A drag emits `move` per frame; only the resting place is worth a file write. */
const SAVE_DEBOUNCE_MS = 400

/** Work areas with the primary display first — see `fitBoundsToWorkAreas`. */
function workAreas(): WorkArea[] {
  const primary = screen.getPrimaryDisplay()
  const rest = screen
    .getAllDisplays()
    .filter((d) => d.id !== primary.id)
    .map((d) => d.workArea)
  return [primary.workArea, ...rest]
}

/**
 * Where the window should open. Without saved state it returns a size only, so
 * Electron centers it the way a first launch always did.
 */
export function openingBounds(
  saved: WindowState | null,
): WindowBounds | { width: number; height: number } {
  if (!saved) {
    return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
  }
  return fitBoundsToWorkAreas(saved.bounds, workAreas())
}

/**
 * Persist size, position and maximised state on a debounce. `close` flushes
 * synchronously: a drag that ends in ⌘Q would otherwise lose its last move to
 * the pending timer.
 */
export function trackWindowState(
  window: BrowserWindow,
  save: (state: WindowState) => void,
  debounceMs = SAVE_DEBOUNCE_MS,
): void {
  let timer: NodeJS.Timeout | null = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (window.isDestroyed()) return
    save({
      // The restore-down frame, not the maximised one: saving the latter makes
      // un-maximising after a restart look like it did nothing.
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    })
  }

  const queue = (): void => {
    if (window.isDestroyed()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }

  window.on("resize", queue)
  window.on("move", queue)
  window.on("maximize", queue)
  window.on("unmaximize", queue)
  window.on("close", flush)
}

export type ZoomController = {
  level: () => number
  /** Re-assert the level on the contents — needed after every load. */
  apply: () => void
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
}

/**
 * Chromium keys zoom by origin and forgets it between runs, so the level is
 * owned here: applied on every load, and written back to settings on change.
 */
export function createZoomController(
  getContents: () => WebContents | null,
  initial: number,
  persist: (level: number) => void,
): ZoomController {
  let level = clampZoomLevel(initial)

  const apply = (): void => {
    const contents = getContents()
    if (!contents || contents.isDestroyed()) return
    contents.setZoomFactor(zoomFactor(level))
  }

  const step = (direction: 1 | -1): void => {
    const next = nextZoomLevel(level, direction)
    if (next === level) return
    level = next
    apply()
    persist(level)
  }

  return {
    level: () => level,
    apply,
    zoomIn: () => step(1),
    zoomOut: () => step(-1),
    reset: () => {
      if (level === DEFAULT_ZOOM_LEVEL) return
      level = DEFAULT_ZOOM_LEVEL
      apply()
      persist(level)
    },
  }
}
