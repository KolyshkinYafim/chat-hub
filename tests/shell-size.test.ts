import { describe, expect, it } from "vitest"
import {
  clampZoomLevel,
  DEFAULT_ZOOM_LEVEL,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  nextZoomLevel,
  zoomFactor,
  zoomPercentLabel,
} from "@shared/zoom"
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_TRANSCRIPT_WIDTH,
  widthKeyCommand,
  WIDTH_KEY_STEP,
  WIDTH_KEY_STEP_LARGE,
} from "@renderer/lib/shell-size"
import {
  clampDockWidth,
  DEFAULT_DOCK_WIDTH,
  maxDockWidth,
  MIN_DOCK_WIDTH,
} from "@renderer/lib/surface-store"

describe("zoom steps", () => {
  it("starts at 100% and moves in Chromium's 20% steps", () => {
    expect(zoomFactor(DEFAULT_ZOOM_LEVEL)).toBe(1)
    expect(zoomPercentLabel(0)).toBe("100%")
    expect(zoomPercentLabel(1)).toBe("120%")
    expect(zoomPercentLabel(-1)).toBe("83%")
  })

  it("stops at both ends rather than running away", () => {
    expect(nextZoomLevel(MAX_ZOOM_LEVEL, 1)).toBe(MAX_ZOOM_LEVEL)
    expect(nextZoomLevel(MIN_ZOOM_LEVEL, -1)).toBe(MIN_ZOOM_LEVEL)
    expect(clampZoomLevel(99)).toBe(MAX_ZOOM_LEVEL)
    expect(clampZoomLevel(-99)).toBe(MIN_ZOOM_LEVEL)
  })

  it("keeps the whole range legible and inside the window's minimum width", () => {
    // At the top step a 900px window must still hold sidebar + transcript.
    expect(900 / zoomFactor(MAX_ZOOM_LEVEL)).toBeGreaterThan(500)
    // At the bottom step 13px base type must not fall under ~9px.
    expect(13 * zoomFactor(MIN_ZOOM_LEVEL)).toBeGreaterThan(8.9)
  })

  it("falls back to 100% for a corrupt persisted value", () => {
    expect(clampZoomLevel(Number.NaN)).toBe(DEFAULT_ZOOM_LEVEL)
    expect(clampZoomLevel(1.4)).toBe(1)
  })
})

describe("sidebar width limits", () => {
  it("holds the default when there is room for it", () => {
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 1512)).toBe(
      DEFAULT_SIDEBAR_WIDTH,
    )
  })

  it("refuses to go below the rail-or-list threshold or past the ceiling", () => {
    expect(clampSidebarWidth(40, 1512)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(2000, 4000)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it("gives up width before the transcript falls under its floor", () => {
    // 1200 viewport with a 460 dock leaves 740; the transcript keeps 420.
    expect(clampSidebarWidth(400, 1200, 460)).toBe(320)
    expect(1200 - 460 - clampSidebarWidth(400, 1200, 460)).toBe(
      MIN_TRANSCRIPT_WIDTH,
    )
  })

  it("still returns a usable sidebar on a window too narrow for everything", () => {
    expect(clampSidebarWidth(300, 900, 460)).toBe(MIN_SIDEBAR_WIDTH)
  })
})

describe("dock width limits", () => {
  it("counts the sidebar when working out how far the dock may go", () => {
    expect(maxDockWidth(1512)).toBe(1092)
    expect(maxDockWidth(1512, 268)).toBe(824)
    expect(clampDockWidth(2000, 1512, 268)).toBe(824)
    expect(1512 - 268 - clampDockWidth(2000, 1512, 268)).toBe(
      MIN_TRANSCRIPT_WIDTH,
    )
  })

  it("keeps the panel usable rather than collapsing it on a narrow window", () => {
    expect(clampDockWidth(DEFAULT_DOCK_WIDTH, 900, 268)).toBe(MIN_DOCK_WIDTH)
    expect(clampDockWidth(10, 1512, 268)).toBe(MIN_DOCK_WIDTH)
  })
})

describe("widthKeyCommand", () => {
  it("grows toward the edge the handle sits on", () => {
    expect(widthKeyCommand("ArrowRight", false, "ArrowRight")).toEqual({
      kind: "delta",
      px: WIDTH_KEY_STEP,
    })
    expect(widthKeyCommand("ArrowLeft", false, "ArrowRight")).toEqual({
      kind: "delta",
      px: -WIDTH_KEY_STEP,
    })
    // The dock's handle is on its left edge, so the sign flips.
    expect(widthKeyCommand("ArrowLeft", false, "ArrowLeft")).toEqual({
      kind: "delta",
      px: WIDTH_KEY_STEP,
    })
  })

  it("takes a coarse step with Shift held", () => {
    expect(widthKeyCommand("ArrowRight", true, "ArrowRight")).toEqual({
      kind: "delta",
      px: WIDTH_KEY_STEP_LARGE,
    })
  })

  it("maps the splitter's Home/End/Enter to the limits and the default", () => {
    expect(widthKeyCommand("Home", false, "ArrowRight")).toEqual({ kind: "min" })
    expect(widthKeyCommand("End", false, "ArrowRight")).toEqual({ kind: "max" })
    expect(widthKeyCommand("Enter", false, "ArrowRight")).toEqual({
      kind: "reset",
    })
    expect(widthKeyCommand(" ", false, "ArrowRight")).toEqual({ kind: "reset" })
  })

  it("ignores everything else so typing elsewhere is unaffected", () => {
    expect(widthKeyCommand("a", false, "ArrowRight")).toBeNull()
    expect(widthKeyCommand("ArrowUp", false, "ArrowRight")).toBeNull()
    expect(widthKeyCommand("Escape", false, "ArrowRight")).toBeNull()
  })
})
