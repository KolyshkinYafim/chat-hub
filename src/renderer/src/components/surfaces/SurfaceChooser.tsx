import type { SurfaceKind } from "../../lib/surface-bridge"
import { SurfaceIcon } from "./SurfaceIcon"

export const SURFACE_LABEL: Record<SurfaceKind, string> = {
  browser: "Browser",
  terminal: "Terminal",
  files: "Files",
  diff: "Diff",
}

const SURFACE_HINT: Record<SurfaceKind, string> = {
  browser: "Open a local app or URL.",
  terminal: "Start a shell in this workspace.",
  files: "Browse and read workspace files.",
  diff: "Review changes in this thread.",
}

const TILE_ORDER: SurfaceKind[] = ["browser", "terminal", "files", "diff"]

type Props = {
  onPick: (kind: SurfaceKind) => void
}

export function SurfaceChooser({ onPick }: Props) {
  return (
    <div className="surface-chooser">
      <div className="surface-chooser-head">
        <h3>Open a surface</h3>
        <p>Choose what to show in the right panel.</p>
      </div>
      <div className="surface-tiles">
        {TILE_ORDER.map((kind) => (
          <button
            key={kind}
            type="button"
            className="surface-tile"
            onClick={() => onPick(kind)}
          >
            <span className="surface-tile-glyph">
              <SurfaceIcon kind={kind} />
            </span>
            <span className="surface-tile-name">{SURFACE_LABEL[kind]}</span>
            <span className="surface-tile-hint">{SURFACE_HINT[kind]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
