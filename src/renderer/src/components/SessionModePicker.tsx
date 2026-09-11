import { useMemo, useRef, useState } from "react"
import type { Mode } from "@shared/settings-types"
import { useOutsideDismiss } from "../lib/use-outside-dismiss"

type Props = {
  modes: Mode[]
  modeId: string | undefined
  onSelect: (modeId: string) => void
}

const MODE_GLYPHS: Record<string, string> = {
  code: "</>",
  plan: "◇",
  review: "✓",
  ask: "?",
}

function fallbackDescription(mode: Mode): string {
  const text = mode.systemPrompt?.replace(/\s+/g, " ").trim() ?? ""
  if (!text) return "A custom way for the agent to work."
  return text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text
}

export function SessionModePicker({ modes, modeId, onSelect }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useOutsideDismiss(rootRef, open, () => setOpen(false))

  const active = useMemo(
    () =>
      modes.find((mode) => mode.id === modeId) ??
      modes.find((mode) => mode.id === "code") ??
      modes[0] ??
      null,
    [modeId, modes],
  )

  if (!active) return null

  return (
    <div className="session-mode-picker" ref={rootRef}>
      <button
        type="button"
        className={`session-mode-trigger mode-${active.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active.description ?? fallbackDescription(active)}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="session-mode-glyph" aria-hidden>
          {MODE_GLYPHS[active.id] ?? "◆"}
        </span>
        <span>{active.name}</span>
        <span className="session-mode-caret" aria-hidden>⌄</span>
      </button>

      {open ? (
        <div className="session-mode-menu" role="menu" aria-label="Session mode">
          <div className="session-mode-menu-head">
            <strong>How should the agent work?</strong>
            <span>You can switch at any time.</span>
          </div>
          {modes.map((mode) => {
            const selected = mode.id === active.id
            return (
              <button
                key={mode.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`session-mode-option${selected ? " is-active" : ""}`}
                onClick={() => {
                  onSelect(mode.id)
                  setOpen(false)
                }}
              >
                <span className={`session-mode-option-glyph mode-${mode.id}`} aria-hidden>
                  {MODE_GLYPHS[mode.id] ?? "◆"}
                </span>
                <span className="session-mode-option-copy">
                  <strong>{mode.name}</strong>
                  <span>{mode.description ?? fallbackDescription(mode)}</span>
                </span>
                {selected ? <span className="session-mode-check">✓</span> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
