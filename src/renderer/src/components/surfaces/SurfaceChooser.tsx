import { SURFACE_LABEL } from "@shared/surfaces"
import type { SurfaceKind } from "../../lib/surface-bridge"
import { SurfaceIcon } from "./SurfaceIcon"

export { SURFACE_LABEL } from "@shared/surfaces"

const SURFACE_HINT: Record<SurfaceKind, string> = {
  board: "Todos and the agent's notes for this project.",
  context: "What this project is, and what it is built with.",
  browser: "Open a local app or URL.",
  terminal: "Start a shell in this workspace.",
  files: "Browse and read workspace files.",
  diff: "Review changes in this thread.",
  history: "Walk recent commits and their diffs.",
  fleet: "Every session at a glance.",
}

const TILE_ORDER: SurfaceKind[] = [
  "board",
  "context",
  "browser",
  "terminal",
  "files",
  "diff",
  "history",
  "fleet",
]

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
