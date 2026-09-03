import { describe, expect, it } from "vitest"
import {
  DEFAULT_ARTBOARD_H,
  DEFAULT_ARTBOARD_W,
  GRID_GAP,
  MAX_ZOOM,
  MIN_ZOOM,
  artboardName,
  clampZoom,
  contentBounds,
  fitView,
  layoutArtboards,
  parseCanvasSpec,
  rectsIntersect,
  viewportRect,
  visibleArtboards,
  zoomAt,
} from "@renderer/lib/design-canvas"

describe("parseCanvasSpec", () => {
  it("reads well-formed artboard entries", () => {
    const specs = parseCanvasSpec(
      JSON.stringify({
        artboards: [
          { file: "a.dc.html", x: 0, y: 10, w: 400, h: 300, name: "Login" },
          { file: "b.dc.html", x: 500, y: 0, w: 720, h: 560 },
        ],
      }),
    )
    expect(specs).toEqual([
      { file: "a.dc.html", x: 0, y: 10, w: 400, h: 300, name: "Login" },
      { file: "b.dc.html", x: 500, y: 0, w: 720, h: 560, name: undefined },
    ])
  })

  it("returns nothing for broken JSON or a missing artboards array", () => {
    expect(parseCanvasSpec("not json {")).toEqual([])
    expect(parseCanvasSpec("42")).toEqual([])
    expect(parseCanvasSpec(JSON.stringify({ boards: [] }))).toEqual([])
    expect(parseCanvasSpec(JSON.stringify({ artboards: "nope" }))).toEqual([])
  })

  it("drops entries with missing files, bad numbers or duplicates", () => {
    const specs = parseCanvasSpec(
      JSON.stringify({
        artboards: [
          { file: "", x: 0, y: 0, w: 100, h: 100 },
          { file: "a.dc.html", x: "0", y: 0, w: 100, h: 100 },
          { file: "b.dc.html", x: 0, y: 0, w: 0, h: 100 },
          { file: "c.dc.html", x: 0, y: 0, w: 100, h: -5 },
          { file: "d.dc.html", x: 0, y: Infinity, w: 100, h: 100 },
          { file: "ok.dc.html", x: 1, y: 2, w: 300, h: 200 },
          { file: "ok.dc.html", x: 9, y: 9, w: 9, h: 9 },
          null,
          "text",
        ],
      }),
    )
    expect(specs).toEqual([
      { file: "ok.dc.html", x: 1, y: 2, w: 300, h: 200, name: undefined },
    ])
  })
})

describe("layoutArtboards", () => {
  it("honours canvas.json placement and derives names", () => {
    const boxes = layoutArtboards(
      ["a.dc.html"],
      [{ file: "a.dc.html", x: 40, y: 50, w: 300, h: 200 }],
    )
    expect(boxes).toEqual([
      { file: "a.dc.html", name: "a", x: 40, y: 50, w: 300, h: 200 },
    ])
  })

  it("auto-grids every file when there is no spec", () => {
    const files = ["a.dc.html", "b.dc.html", "c.dc.html"]
    const boxes = layoutArtboards(files, [])
    expect(boxes.map((b) => b.file)).toEqual(files)
    expect(boxes[0]).toMatchObject({ x: 0, y: 0 })
    expect(boxes[1]).toMatchObject({
      x: DEFAULT_ARTBOARD_W + GRID_GAP,
      y: 0,
    })
    expect(boxes[2]).toMatchObject({
      x: 0,
      y: DEFAULT_ARTBOARD_H + GRID_GAP,
    })
  })

  it("places unspecced files below the specced content", () => {
    const boxes = layoutArtboards(
      ["a.dc.html", "extra.dc.html"],
      [{ file: "a.dc.html", x: 0, y: 100, w: 400, h: 300 }],
    )
    const extra = boxes.find((b) => b.file === "extra.dc.html")
    expect(extra).toMatchObject({
      x: 0,
      y: 400 + GRID_GAP,
      w: DEFAULT_ARTBOARD_W,
      h: DEFAULT_ARTBOARD_H,
      name: "extra",
    })
  })

  it("ignores spec entries for files that are not on disk", () => {
    const boxes = layoutArtboards(
      ["a.dc.html"],
      [
        { file: "a.dc.html", x: 0, y: 0, w: 100, h: 100 },
        { file: "ghost.dc.html", x: 900, y: 900, w: 100, h: 100 },
      ],
    )
    expect(boxes).toHaveLength(1)
    expect(boxes[0].file).toBe("a.dc.html")
  })
})

describe("artboardName", () => {
  it("strips the .dc.html suffix and survives odd names", () => {
    expect(artboardName("login.dc.html")).toBe("login")
    expect(artboardName("plain.html")).toBe("plain.html")
    expect(artboardName(".dc.html")).toBe(".dc.html")
  })
})

describe("clampZoom", () => {
  it("clamps into the 10%–400% range and defuses non-finite input", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM)
    expect(clampZoom(9)).toBe(MAX_ZOOM)
    expect(clampZoom(1.5)).toBe(1.5)
    expect(clampZoom(Number.NaN)).toBe(1)
  })
})

describe("fitView and contentBounds", () => {
  it("centres the content and never zooms past 100%", () => {
    const bounds = contentBounds([
      { file: "a", name: "a", x: 0, y: 0, w: 100, h: 100 },
      { file: "b", name: "b", x: 200, y: 100, w: 100, h: 100 },
    ])
    expect(bounds).toEqual({ x: 0, y: 0, w: 300, h: 200 })
    const view = fitView(bounds, 1000, 800, 0)
    expect(view.zoom).toBe(1)
    expect(view.panX).toBe(350)
    expect(view.panY).toBe(300)
  })

  it("zooms out for content larger than the viewport", () => {
    const view = fitView({ x: 0, y: 0, w: 4000, h: 1000 }, 1000, 800, 0)
    expect(view.zoom).toBeCloseTo(0.25)
    expect(view.panX).toBeCloseTo(0)
    expect(view.panY).toBeCloseTo(275)
  })

  it("falls back to identity for empty content", () => {
    expect(contentBounds([])).toBeNull()
    expect(fitView(null, 800, 600)).toEqual({ zoom: 1, panX: 0, panY: 0 })
  })
})

describe("viewport culling", () => {
  it("maps the screen viewport into canvas space", () => {
    const vp = viewportRect({ zoom: 2, panX: -100, panY: 50 }, 800, 600)
    expect(vp).toEqual({ x: 50, y: -25, w: 400, h: 300 })
  })

  it("intersects rectangles without counting touching edges", () => {
    const a = { x: 0, y: 0, w: 100, h: 100 }
    expect(rectsIntersect(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true)
    expect(rectsIntersect(a, { x: 100, y: 0, w: 10, h: 10 })).toBe(false)
    expect(rectsIntersect(a, { x: 500, y: 500, w: 10, h: 10 })).toBe(false)
  })

  it("keeps nearby artboards mounted and culls far ones", () => {
    const boxes = [
      { file: "near", name: "near", x: 0, y: 0, w: 100, h: 100 },
      { file: "margin", name: "margin", x: 1100, y: 0, w: 100, h: 100 },
      { file: "far", name: "far", x: 5000, y: 5000, w: 100, h: 100 },
    ]
    const visible = visibleArtboards(
      boxes,
      { zoom: 1, panX: 0, panY: 0 },
      800,
      600,
    )
    expect(visible.has("near")).toBe(true)
    expect(visible.has("margin")).toBe(true)
    expect(visible.has("far")).toBe(false)
  })
})

describe("zoomAt", () => {
  it("keeps the point under the cursor fixed while zooming", () => {
    const view = { zoom: 1, panX: 0, panY: 0 }
    const next = zoomAt(view, 2, 400, 300)
    expect(next.zoom).toBe(2)
    expect((400 - next.panX) / next.zoom).toBeCloseTo(400)
    expect((300 - next.panY) / next.zoom).toBeCloseTo(300)
  })

  it("clamps the requested zoom", () => {
    const next = zoomAt({ zoom: 1, panX: 0, panY: 0 }, 100, 0, 0)
    expect(next.zoom).toBe(MAX_ZOOM)
  })
})
