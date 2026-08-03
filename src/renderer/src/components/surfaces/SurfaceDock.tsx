import { useCallback, useEffect, useRef, type PointerEvent } from "react"
import type { SessionMeta } from "@shared/types"
import type { SurfaceKind } from "../../lib/surface-bridge"
import {
  clampDockWidth,
  DEFAULT_DOCK_WIDTH,
  SURFACE_KINDS,
} from "../../lib/surface-store"
import { SURFACE_LABEL, SurfaceChooser } from "./SurfaceChooser"
import { SurfaceIcon } from "./SurfaceIcon"
import { BoardSurface } from "./BoardSurface"
import { BrowserSurface } from "./BrowserSurface"
import { DiffSurface } from "./DiffSurface"
import { FilesSurface } from "./FilesSurface"
import { TerminalSurface } from "./TerminalSurface"

type Props = {
  session: SessionMeta
  kind: SurfaceKind | null
  width: number
  gitRefreshKey: number
  /** File the transcript asked the Diff panel to show; `at` re-fires a repeat. */
  diffFocus: { path: string; at: number } | null
  onGitChanged: () => void
  onSelectKind: (kind: SurfaceKind | null) => void
  onWidthChange: (width: number) => void
  onWidthCommit: (width: number) => void
  onClose: () => void
}

export function SurfaceDock({
  session,
  kind,
  width,
  gitRefreshKey,
  diffFocus,
  onGitChanged,
  onSelectKind,
  onWidthChange,
  onWidthCommit,
  onClose,
}: Props) {
  const widthRef = useRef(width)

  useEffect(() => {
    widthRef.current = width
  }, [width])

  const startResize = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const move = (ev: globalThis.PointerEvent) => {
        const next = clampDockWidth(
          window.innerWidth - ev.clientX,
          window.innerWidth,
        )
        widthRef.current = next
        onWidthChange(next)
      }
      const stop = () => {
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", stop)
        handle.removeEventListener("pointercancel", stop)
        onWidthCommit(widthRef.current)
      }
      handle.addEventListener("pointermove", move)
      handle.addEventListener("pointerup", stop)
      handle.addEventListener("pointercancel", stop)
    },
    [onWidthChange, onWidthCommit],
  )

  return (
    <aside className="surface-dock" aria-label="Surface panel">
      <div
        className="surface-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={startResize}
        onDoubleClick={() => {
          onWidthChange(DEFAULT_DOCK_WIDTH)
          onWidthCommit(DEFAULT_DOCK_WIDTH)
        }}
      />
      <header className="surface-head">
        <div className="surface-tabs">
          {SURFACE_KINDS.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`surface-tab ${kind === tab ? "active" : ""}`}
              title={
                kind === tab
                  ? `${SURFACE_LABEL[tab]} — click again for the chooser`
                  : SURFACE_LABEL[tab]
              }
              aria-pressed={kind === tab}
              onClick={() => onSelectKind(kind === tab ? null : tab)}
            >
              <SurfaceIcon kind={tab} />
            </button>
          ))}
        </div>
        <span className="surface-head-label">
          {kind === null ? "Surfaces" : SURFACE_LABEL[kind]}
        </span>
        <button
          type="button"
          className="surface-close"
          title="Close panel"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="surface-body">
        {kind === null ? <SurfaceChooser onPick={onSelectKind} /> : null}
        {kind === "board" ? <BoardSurface key={session.id} cwd={session.cwd} /> : null}
        {kind === "browser" ? <BrowserSurface key={session.id} /> : null}
        {kind === "terminal" ? (
          <TerminalSurface key={session.id} cwd={session.cwd} />
        ) : null}
        {kind === "files" ? (
          <FilesSurface key={session.id} cwd={session.cwd} />
        ) : null}
        {kind === "diff" ? (
          <DiffSurface
            key={session.id}
            cwd={session.cwd}
            refreshKey={gitRefreshKey}
            focus={diffFocus}
            onClose={onClose}
            onChanged={onGitChanged}
          />
        ) : null}
      </div>
    </aside>
  )
}
