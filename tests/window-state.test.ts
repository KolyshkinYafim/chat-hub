import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BrowserWindow, WebContents } from "electron"
import type { WindowState } from "@shared/window-bounds"

const displays = vi.hoisted(() => ({
  primary: { id: 1, workArea: { x: 0, y: 25, width: 1512, height: 945 } },
  all: [] as { id: number; workArea: Record<string, number> }[],
}))

vi.mock("electron", () => ({
  screen: {
    getPrimaryDisplay: () => displays.primary,
    getAllDisplays: () => displays.all,
  },
}))

const { createZoomController, openingBounds, trackWindowState } = await import(
  "../src/main/window-state"
)

type Handler = () => void

function fakeWindow(bounds: WindowState["bounds"]) {
  const handlers = new Map<string, Handler[]>()
  const window = {
    destroyed: false,
    maximized: false,
    bounds,
    isDestroyed: () => window.destroyed,
    isMaximized: () => window.maximized,
    getNormalBounds: () => window.bounds,
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return window
    },
  }
  return {
    window: window as unknown as BrowserWindow,
    raw: window,
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler()
    },
  }
}

function fakeContents() {
  const contents = {
    destroyed: false,
    factors: [] as number[],
    isDestroyed: () => contents.destroyed,
    setZoomFactor: (factor: number) => contents.factors.push(factor),
  }
  return contents
}

beforeEach(() => {
  displays.all = [displays.primary]
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("openingBounds", () => {
  it("gives a size only on first launch so Electron centers the window", () => {
    expect(openingBounds(null)).toEqual({ width: 1280, height: 840 })
  })

  it("refits saved geometry against the displays attached now", () => {
    const saved: WindowState = {
      bounds: { x: 3000, y: 100, width: 1280, height: 840 },
      maximized: false,
    }
    const opened = openingBounds(saved) as WindowState["bounds"]
    expect(opened.x).toBeGreaterThanOrEqual(0)
    expect(opened.x + opened.width).toBeLessThanOrEqual(1512)
  })
})

describe("trackWindowState", () => {
  it("writes once for a burst of move events, not once per frame", () => {
    const host = fakeWindow({ x: 10, y: 20, width: 1280, height: 840 })
    const saved: WindowState[] = []
    trackWindowState(host.window, (s) => saved.push(s), 400)

    for (let i = 0; i < 20; i += 1) host.emit("move")
    expect(saved).toHaveLength(0)

    vi.advanceTimersByTime(400)
    expect(saved).toEqual([
      { bounds: { x: 10, y: 20, width: 1280, height: 840 }, maximized: false },
    ])
  })

  it("records the restore-down frame alongside the maximised flag", () => {
    const host = fakeWindow({ x: 10, y: 20, width: 1280, height: 840 })
    const saved: WindowState[] = []
    trackWindowState(host.window, (s) => saved.push(s), 400)

    host.raw.maximized = true
    host.emit("maximize")
    vi.advanceTimersByTime(400)
    expect(saved.at(-1)).toEqual({
      bounds: { x: 10, y: 20, width: 1280, height: 840 },
      maximized: true,
    })
  })

  it("flushes on close so a drag that ends in a quit is not lost", () => {
    const host = fakeWindow({ x: 10, y: 20, width: 1280, height: 840 })
    const saved: WindowState[] = []
    trackWindowState(host.window, (s) => saved.push(s), 400)

    host.emit("move")
    host.emit("close")
    expect(saved).toHaveLength(1)

    // The pending timer must not fire a second write afterwards.
    vi.advanceTimersByTime(400)
    expect(saved).toHaveLength(1)
  })

  it("stops writing once the window is gone", () => {
    const host = fakeWindow({ x: 10, y: 20, width: 1280, height: 840 })
    const saved: WindowState[] = []
    trackWindowState(host.window, (s) => saved.push(s), 400)

    host.emit("resize")
    host.raw.destroyed = true
    vi.advanceTimersByTime(400)
    expect(saved).toHaveLength(0)
  })
})

describe("createZoomController", () => {
  it("re-asserts the persisted level on demand without a write", () => {
    const contents = fakeContents()
    const written: number[] = []
    const zoom = createZoomController(
      () => contents as unknown as WebContents,
      2,
      (level) => written.push(level),
    )

    zoom.apply()
    expect(contents.factors).toEqual([1.2 ** 2])
    expect(written).toEqual([])
  })

  it("persists every step and refuses to run past the limits", () => {
    const contents = fakeContents()
    const written: number[] = []
    const zoom = createZoomController(
      () => contents as unknown as WebContents,
      0,
      (level) => written.push(level),
    )

    zoom.zoomIn()
    zoom.zoomIn()
    zoom.zoomIn()
    zoom.zoomIn()
    expect(zoom.level()).toBe(3)
    expect(written).toEqual([1, 2, 3])

    zoom.reset()
    expect(zoom.level()).toBe(0)
    expect(written.at(-1)).toBe(0)
    // Already at 100%: nothing to apply, nothing to write.
    zoom.reset()
    expect(written).toHaveLength(4)
  })

  it("no-ops safely once the contents are destroyed", () => {
    const contents = fakeContents()
    contents.destroyed = true
    const zoom = createZoomController(
      () => contents as unknown as WebContents,
      0,
      () => {},
    )
    zoom.zoomIn()
    expect(contents.factors).toEqual([])
    expect(zoom.level()).toBe(1)
  })
})
