import { describe, expect, it } from "vitest"
import {
  fitBoundsToWorkAreas,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  parseWindowState,
  parseWindowStates,
  windowsToReopen,
  type PersistedWindow,
  type WorkArea,
} from "@shared/window-bounds"

const LAPTOP: WorkArea = { x: 0, y: 25, width: 1512, height: 945 }
/** A second screen sitting to the right of the laptop. */
const EXTERNAL: WorkArea = { x: 1512, y: 0, width: 2560, height: 1415 }

describe("parseWindowState", () => {
  it("reads back what was written", () => {
    expect(
      parseWindowState({
        bounds: { x: 10, y: 20, width: 1280, height: 840 },
        maximized: true,
      }),
    ).toEqual({
      bounds: { x: 10, y: 20, width: 1280, height: 840 },
      maximized: true,
    })
  })

  it("rounds fractional geometry from a scaled display", () => {
    expect(
      parseWindowState({
        bounds: { x: 10.4, y: 20.6, width: 1280.5, height: 840.2 },
      })?.bounds,
    ).toEqual({ x: 10, y: 21, width: 1281, height: 840 })
  })

  it("rejects anything it cannot trust rather than half-applying it", () => {
    expect(parseWindowState(null)).toBeNull()
    expect(parseWindowState({})).toBeNull()
    expect(parseWindowState({ bounds: { x: 0, y: 0, width: 100 } })).toBeNull()
    expect(
      parseWindowState({ bounds: { x: 0, y: 0, width: 0, height: 500 } }),
    ).toBeNull()
    expect(
      parseWindowState({
        bounds: { x: Number.NaN, y: 0, width: 100, height: 100 },
      }),
    ).toBeNull()
  })

  it("treats a missing maximized flag as not maximized", () => {
    expect(
      parseWindowState({ bounds: { x: 0, y: 0, width: 900, height: 600 } })
        ?.maximized,
    ).toBe(false)
  })
})

describe("fitBoundsToWorkAreas", () => {
  it("leaves a window that still fits exactly where it was", () => {
    const saved = { x: 100, y: 120, width: 1280, height: 840 }
    expect(fitBoundsToWorkAreas(saved, [LAPTOP, EXTERNAL])).toEqual(saved)
  })

  it("keeps a window on the screen it was last on, not the primary", () => {
    const saved = { x: 1800, y: 200, width: 1400, height: 900 }
    expect(fitBoundsToWorkAreas(saved, [LAPTOP, EXTERNAL])).toEqual(saved)
  })

  it("re-centers on the primary when its display was unplugged", () => {
    // Saved on the external screen; only the laptop is attached now.
    const saved = { x: 1800, y: 200, width: 1400, height: 900 }
    expect(fitBoundsToWorkAreas(saved, [LAPTOP])).toEqual({
      x: 56,
      y: 48,
      width: 1400,
      height: 900,
    })
  })

  it("slides a window that hangs off the edge back into view", () => {
    const saved = { x: 1200, y: 800, width: 1280, height: 840 }
    expect(fitBoundsToWorkAreas(saved, [LAPTOP])).toEqual({
      x: 232,
      y: 130,
      width: 1280,
      height: 840,
    })
  })

  it("shrinks a window saved on a bigger screen to the one it lands on", () => {
    const saved = { x: 1512, y: 0, width: 2400, height: 1300 }
    const fitted = fitBoundsToWorkAreas(saved, [LAPTOP])
    expect(fitted.width).toBe(LAPTOP.width)
    expect(fitted.height).toBe(LAPTOP.height)
    expect(fitted.x).toBe(LAPTOP.x)
    expect(fitted.y).toBe(LAPTOP.y)
  })

  it("never returns a frame below the window's own minimum", () => {
    const tiny: WorkArea = { x: 0, y: 0, width: 640, height: 480 }
    const fitted = fitBoundsToWorkAreas(
      { x: 0, y: 0, width: 300, height: 200 },
      [tiny],
    )
    expect(fitted.width).toBe(MIN_WINDOW_WIDTH)
    expect(fitted.height).toBe(MIN_WINDOW_HEIGHT)
    // A frame wider than the screen pins to the screen's own origin.
    expect(fitted.x).toBe(0)
    expect(fitted.y).toBe(0)
  })

  it("re-centers a window left peeking in by a sliver", () => {
    const saved = { x: 1480, y: 900, width: 1280, height: 840 }
    const fitted = fitBoundsToWorkAreas(saved, [LAPTOP])
    expect(fitted).toEqual({ x: 116, y: 78, width: 1280, height: 840 })
  })

  it("falls back to a usable frame when no display is reported at all", () => {
    const fitted = fitBoundsToWorkAreas(
      { x: 4000, y: 4000, width: 1280, height: 840 },
      [],
    )
    expect(fitted.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH)
    expect(fitted.height).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT)
  })
})

const BOUNDS = { x: 10, y: 20, width: 1000, height: 700 }

function persisted(windowId: number): PersistedWindow {
  return { windowId, bounds: BOUNDS, maximized: false }
}

describe("parseWindowStates", () => {
  it("reads back a list the last run wrote", () => {
    expect(
      parseWindowStates([
        { windowId: 1, bounds: BOUNDS, maximized: false },
        { windowId: 2, bounds: BOUNDS, maximized: true },
      ]),
    ).toEqual([
      { windowId: 1, bounds: BOUNDS, maximized: false },
      { windowId: 2, bounds: BOUNDS, maximized: true },
    ])
  })

  it("sorts by id so the reopen order does not depend on the file", () => {
    const parsed = parseWindowStates([persisted(3), persisted(1)])
    expect(parsed?.map((w) => w.windowId)).toEqual([1, 3])
  })

  it("drops one bad row rather than losing the whole list", () => {
    const parsed = parseWindowStates([
      persisted(1),
      { windowId: 2, bounds: { x: 0, y: 0, width: 0, height: 5 } },
      persisted(3),
    ])
    expect(parsed?.map((w) => w.windowId)).toEqual([1, 3])
  })

  it("refuses a row with no usable id", () => {
    const parsed = parseWindowStates([
      { bounds: BOUNDS, maximized: false },
      { windowId: 0, bounds: BOUNDS, maximized: false },
      { windowId: -2, bounds: BOUNDS, maximized: false },
      { windowId: 1.5, bounds: BOUNDS, maximized: false },
      persisted(4),
    ])
    expect(parsed?.map((w) => w.windowId)).toEqual([4])
  })

  it("keeps the first of a duplicated id", () => {
    const parsed = parseWindowStates([
      { windowId: 1, bounds: BOUNDS, maximized: true },
      { windowId: 1, bounds: BOUNDS, maximized: false },
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed?.[0]?.maximized).toBe(true)
  })

  it("reads anything that is not a usable list as no list", () => {
    expect(parseWindowStates(null)).toBeNull()
    expect(parseWindowStates(undefined)).toBeNull()
    expect(parseWindowStates({})).toBeNull()
    expect(parseWindowStates("[]")).toBeNull()
    expect(parseWindowStates([])).toBeNull()
    expect(parseWindowStates([null, 7, "x"])).toBeNull()
  })
})

describe("windowsToReopen", () => {
  it("puts back exactly the set the last run left open", () => {
    expect(windowsToReopen([persisted(1), persisted(3)])).toEqual([
      { windowId: 1, state: { bounds: BOUNDS, maximized: false } },
      { windowId: 3, state: { bounds: BOUNDS, maximized: false } },
    ])
  })

  it("opens window 1 with no saved geometry on a first launch", () => {
    expect(windowsToReopen(null)).toEqual([{ windowId: 1, state: null }])
    expect(windowsToReopen([])).toEqual([{ windowId: 1, state: null }])
  })

  it("never returns nothing, so a launch always has a window", () => {
    for (const saved of [null, [], [persisted(2)]]) {
      expect(windowsToReopen(saved).length).toBeGreaterThan(0)
    }
  })

  it("does not resurrect window 1 when the user closed it", () => {
    expect(windowsToReopen([persisted(2)])).toEqual([
      { windowId: 2, state: { bounds: BOUNDS, maximized: false } },
    ])
  })
})
