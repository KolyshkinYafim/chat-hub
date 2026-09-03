export type ArtboardSpec = {
  file: string
  x: number
  y: number
  w: number
  h: number
  name?: string
}

export type ArtboardBox = {
  file: string
  name: string
  x: number
  y: number
  w: number
  h: number
}

export type Rect = { x: number; y: number; w: number; h: number }

export type CanvasView = { zoom: number; panX: number; panY: number }

export const MIN_ZOOM = 0.1

export const MAX_ZOOM = 4

export const DEFAULT_ARTBOARD_W = 800

export const DEFAULT_ARTBOARD_H = 600

export const GRID_GAP = 80

export const FIT_PADDING = 48

export const ARTBOARD_EXT = ".dc.html"

export const CANVAS_SPEC_FILE = "canvas.json"

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

export function artboardName(file: string): string {
  const base = file.endsWith(ARTBOARD_EXT)
    ? file.slice(0, -ARTBOARD_EXT.length)
    : file
  return base === "" ? file : base
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

export function parseCanvasSpec(text: string): ArtboardSpec[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const artboards = (parsed as Record<string, unknown>).artboards
  if (!Array.isArray(artboards)) return []
  const out: ArtboardSpec[] = []
  const seen = new Set<string>()
  for (const raw of artboards) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const o = raw as Record<string, unknown>
    if (typeof o.file !== "string" || o.file === "" || seen.has(o.file)) continue
    if (!finiteNumber(o.x) || !finiteNumber(o.y)) continue
    if (!finitePositive(o.w) || !finitePositive(o.h)) continue
    seen.add(o.file)
    out.push({
      file: o.file,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      name: typeof o.name === "string" && o.name !== "" ? o.name : undefined,
    })
  }
  return out
}

export function layoutArtboards(
  files: string[],
  specs: ArtboardSpec[],
): ArtboardBox[] {
  const byFile = new Map(specs.map((s) => [s.file, s]))
  const placed: ArtboardBox[] = []
  const loose: string[] = []
  for (const file of files) {
    const spec = byFile.get(file)
    if (spec) {
      placed.push({
        file,
        name: spec.name ?? artboardName(file),
        x: spec.x,
        y: spec.y,
        w: spec.w,
        h: spec.h,
      })
    } else {
      loose.push(file)
    }
  }
  if (loose.length === 0) return placed
  const startY =
    placed.length === 0
      ? 0
      : Math.max(...placed.map((b) => b.y + b.h)) + GRID_GAP
  const cols = Math.max(1, Math.ceil(Math.sqrt(loose.length)))
  const grid = loose.map((file, i) => ({
    file,
    name: artboardName(file),
    x: (i % cols) * (DEFAULT_ARTBOARD_W + GRID_GAP),
    y: startY + Math.floor(i / cols) * (DEFAULT_ARTBOARD_H + GRID_GAP),
    w: DEFAULT_ARTBOARD_W,
    h: DEFAULT_ARTBOARD_H,
  }))
  return [...placed, ...grid]
}

export function contentBounds(boxes: readonly ArtboardBox[]): Rect | null {
  if (boxes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function fitView(
  bounds: Rect | null,
  viewW: number,
  viewH: number,
  padding = FIT_PADDING,
): CanvasView {
  if (!bounds || bounds.w <= 0 || bounds.h <= 0 || viewW <= 0 || viewH <= 0) {
    return { zoom: 1, panX: 0, panY: 0 }
  }
  const usableW = Math.max(1, viewW - padding * 2)
  const usableH = Math.max(1, viewH - padding * 2)
  const zoom = clampZoom(
    Math.min(1, usableW / bounds.w, usableH / bounds.h),
  )
  return {
    zoom,
    panX: (viewW - bounds.w * zoom) / 2 - bounds.x * zoom,
    panY: (viewH - bounds.h * zoom) / 2 - bounds.y * zoom,
  }
}

export function viewportRect(
  view: CanvasView,
  viewW: number,
  viewH: number,
): Rect {
  return {
    x: -view.panX / view.zoom,
    y: -view.panY / view.zoom,
    w: viewW / view.zoom,
    h: viewH / view.zoom,
  }
}

export function expandRect(rect: Rect, margin: number): Rect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    w: rect.w + margin * 2,
    h: rect.h + margin * 2,
  }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  )
}

export function visibleArtboards(
  boxes: readonly ArtboardBox[],
  view: CanvasView,
  viewW: number,
  viewH: number,
): Set<string> {
  const vp = viewportRect(view, viewW, viewH)
  const window = expandRect(vp, Math.max(vp.w, vp.h) / 2)
  const out = new Set<string>()
  for (const b of boxes) {
    if (rectsIntersect(b, window)) out.add(b.file)
  }
  return out
}

export function zoomAt(
  view: CanvasView,
  nextZoom: number,
  cursorX: number,
  cursorY: number,
): CanvasView {
  const zoom = clampZoom(nextZoom)
  const canvasX = (cursorX - view.panX) / view.zoom
  const canvasY = (cursorY - view.panY) / view.zoom
  return {
    zoom,
    panX: cursorX - canvasX * zoom,
    panY: cursorY - canvasY * zoom,
  }
}
