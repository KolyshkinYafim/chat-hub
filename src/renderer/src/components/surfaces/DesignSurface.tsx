import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ARTBOARD_EXT,
  CANVAS_SPEC_FILE,
  clampZoom,
  contentBounds,
  fitView,
  layoutArtboards,
  parseCanvasSpec,
  visibleArtboards,
  zoomAt,
  type ArtboardBox,
  type CanvasView,
} from "../../lib/design-canvas"
import { errorText, surfaceBridge } from "../../lib/surface-bridge"

export type DesignFocus = { path: string; at: number }

type Props = {
  cwd: string
  focus?: DesignFocus | null
}

type Source = { root: string; rel: string; implicit: boolean }

type LoadState =
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "error"; detail: string }
  | { phase: "ready"; artboards: ArtboardBox[] }

const DEFAULT_REL = "design"

function joinRel(rel: string, name: string): string {
  return rel === "" ? name : `${rel}/${name}`
}

function sourceLabel(source: Source): string {
  if (source.rel !== "") return source.rel
  const parts = source.root.split("/").filter((p) => p !== "")
  return parts[parts.length - 1] ?? source.root
}

export function DesignSurface({ cwd, focus = null }: Props) {
  const [source, setSource] = useState<Source>(() =>
    focus
      ? { root: cwd, rel: focus.path, implicit: false }
      : { root: cwd, rel: DEFAULT_REL, implicit: true },
  )
  const [load, setLoad] = useState<LoadState>({ phase: "loading" })
  const [docs, setDocs] = useState<Record<string, string>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [view, setView] = useState<CanvasView>({ zoom: 1, panX: 0, panY: 0 })
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef(true)
  const viewRef = useRef(view)
  const fetchingRef = useRef(new Set<string>())
  const fittedRef = useRef(false)
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  )

  viewRef.current = view

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (focus) {
      setSource({ root: cwd, rel: focus.path, implicit: false })
    }
  }, [cwd, focus])

  useEffect(() => {
    let cancelled = false
    setLoad({ phase: "loading" })
    setDocs({})
    setFailed({})
    fetchingRef.current = new Set()
    fittedRef.current = false
    const run = async () => {
      const bridge = surfaceBridge()
      try {
        const listing = await bridge.listDir(source.root, source.rel)
        if (cancelled) return
        const files = listing.entries
          .filter((e) => e.kind === "file" && e.name.endsWith(ARTBOARD_EXT))
          .map((e) => e.name)
        if (files.length === 0) {
          setLoad({ phase: "empty" })
          return
        }
        const hasSpec = listing.entries.some(
          (e) => e.kind === "file" && e.name === CANVAS_SPEC_FILE,
        )
        let specs: ReturnType<typeof parseCanvasSpec> = []
        if (hasSpec) {
          try {
            const spec = await bridge.readFileText(
              source.root,
              joinRel(source.rel, CANVAS_SPEC_FILE),
            )
            specs = parseCanvasSpec(spec.text)
          } catch {
            specs = []
          }
        }
        if (cancelled) return
        setLoad({ phase: "ready", artboards: layoutArtboards(files, specs) })
      } catch (err) {
        if (cancelled) return
        if (source.implicit) {
          setLoad({ phase: "empty" })
        } else {
          setLoad({ phase: "error", detail: errorText(err) })
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [source])

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const measure = () => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [load.phase])

  const artboards = load.phase === "ready" ? load.artboards : null

  const fit = useCallback(() => {
    if (!artboards || size.w === 0 || size.h === 0) return
    setView(fitView(contentBounds(artboards), size.w, size.h))
  }, [artboards, size])

  useEffect(() => {
    if (fittedRef.current) return
    if (!artboards || size.w === 0 || size.h === 0) return
    fittedRef.current = true
    fit()
  }, [artboards, size, fit])

  const visible = useMemo(() => {
    if (!artboards || size.w === 0 || size.h === 0) {
      return new Set<string>()
    }
    return visibleArtboards(artboards, view, size.w, size.h)
  }, [artboards, view, size])

  useEffect(() => {
    if (!artboards) return
    const bridge = surfaceBridge()
    for (const box of artboards) {
      if (!visible.has(box.file)) continue
      if (docs[box.file] !== undefined || failed[box.file] !== undefined) {
        continue
      }
      if (fetchingRef.current.has(box.file)) continue
      fetchingRef.current.add(box.file)
      void bridge
        .readFileText(source.root, joinRel(source.rel, box.file))
        .then((contents) => {
          if (!liveRef.current) return
          setDocs((curr) => ({ ...curr, [box.file]: contents.text }))
        })
        .catch((err) => {
          if (!liveRef.current) return
          setFailed((curr) => ({ ...curr, [box.file]: errorText(err) }))
        })
        .finally(() => {
          fetchingRef.current.delete(box.file)
        })
    }
  }, [artboards, visible, docs, failed, source])

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const cursorX = event.clientX - rect.left
      const cursorY = event.clientY - rect.top
      setView((curr) => {
        if (event.ctrlKey || event.metaKey) {
          const next = clampZoom(curr.zoom * Math.exp(-event.deltaY * 0.01))
          return zoomAt(curr, next, cursorX, cursorY)
        }
        return {
          zoom: curr.zoom,
          panX: curr.panX - event.deltaX,
          panY: curr.panY - event.deltaY,
        }
      })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      el.removeEventListener("wheel", onWheel)
    }
  }, [load.phase])

  const pickFolder = useCallback(async () => {
    const picked = await window.chatHub.pickFolder()
    if (!picked || !liveRef.current) return
    setSource({ root: picked, rel: "", implicit: false })
  }, [])

  if (load.phase === "loading") {
    return <div className="design-status">Loading artboards…</div>
  }

  if (load.phase === "error" || load.phase === "empty") {
    return (
      <div className="design-empty">
        <p className="design-empty-title">
          {load.phase === "error" ? "Could not open the folder" : "No artboards"}
        </p>
        <p className="design-empty-hint">
          {load.phase === "error"
            ? load.detail
            : source.implicit
              ? `This project has no ${DEFAULT_REL}/ folder with ${ARTBOARD_EXT} artboards yet.`
              : `No ${ARTBOARD_EXT} artboards in this folder.`}
        </p>
        <button type="button" className="tb-btn" onClick={() => void pickFolder()}>
          Choose folder…
        </button>
      </div>
    )
  }

  return (
    <div className="design-surface">
      <div className="design-toolbar">
        <span className="design-toolbar-source" title={`${source.root}/${source.rel}`}>
          {sourceLabel(source)}
        </span>
        <span className="design-toolbar-count">
          {load.artboards.length}{" "}
          {load.artboards.length === 1 ? "artboard" : "artboards"}
        </span>
        <span className="design-toolbar-zoom">
          {Math.round(view.zoom * 100)}%
        </span>
        <button type="button" className="tb-btn" onClick={fit}>
          Fit
        </button>
        <button
          type="button"
          className="tb-btn"
          onClick={() => void pickFolder()}
        >
          Folder…
        </button>
      </div>
      <div
        ref={canvasRef}
        className="design-canvas"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          const dx = event.clientX - drag.x
          const dy = event.clientY - drag.y
          drag.x = event.clientX
          drag.y = event.clientY
          setView((curr) => ({
            zoom: curr.zoom,
            panX: curr.panX + dx,
            panY: curr.panY + dy,
          }))
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null
          }
        }}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null
          }
        }}
      >
        <div
          className="design-layer"
          style={{
            transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
          }}
        >
          {load.artboards.map((box) => (
            <div
              key={box.file}
              className="design-artboard"
              style={{
                left: box.x,
                top: box.y,
                width: box.w,
                height: box.h,
              }}
            >
              <div
                className="design-artboard-label"
                style={{ transform: `scale(${1 / view.zoom})` }}
              >
                {box.name}
              </div>
              {visible.has(box.file) && docs[box.file] !== undefined ? (
                <iframe
                  className="design-artboard-frame"
                  title={box.name}
                  sandbox=""
                  srcDoc={docs[box.file]}
                />
              ) : (
                <div className="design-artboard-placeholder">
                  {failed[box.file] ?? box.name}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
