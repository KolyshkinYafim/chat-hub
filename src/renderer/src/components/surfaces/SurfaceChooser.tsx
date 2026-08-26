import { SURFACE_HINT, SURFACE_KINDS, SURFACE_LABEL } from "@shared/surfaces"
import type { SurfaceKind } from "../../lib/surface-bridge"
import { SurfaceIcon } from "./SurfaceIcon"

export { SURFACE_LABEL } from "@shared/surfaces"

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
        {SURFACE_KINDS.map((kind) => (
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
