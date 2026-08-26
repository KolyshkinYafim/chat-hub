import { useEffect } from "react"

type Props = {
  onClose: () => void
}

const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "⌘K", what: "Switch session — fuzzy over title / project / agent" },
  { keys: "⌘P", what: "Go to file — fuzzy over the project tree" },
  { keys: "⇧⌘F", what: "Search in project — content matches, jump to the line" },
  { keys: "⌘N", what: "New session" },
  { keys: "⌘,", what: "Settings" },
  { keys: "⌘/", what: "This list" },
  { keys: "⌘G", what: "Diff surface — stage, diff, commit" },
  { keys: "⌘Y", what: "History surface — commits and their diffs" },
  { keys: "⌘B", what: "Right panel — browser, terminal, files, diff" },
  {
    keys: "⌥⌘←→",
    what: "Move between panes — drag a session onto a pane edge to split (⇧ moves the pane)",
  },
  { keys: "Enter", what: "Send · Shift+Enter for a newline" },
  { keys: "⌘Enter", what: "Send from anywhere in the composer" },
  { keys: "Esc", what: "Stop the running turn" },
]

/** Discoverability for the keymap — the bindings are useless if unlisted. */
export function ShortcutsOverlay({ onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-panel shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Keyboard</h2>
          <button type="button" className="icon-chip" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="modal-body shortcuts-body">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="shortcut-row">
              <span className="kbd">{s.keys}</span>
              <span>{s.what}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
