import { useOverlay } from "../lib/use-overlay"
import { hostPlatform, keyHint } from "../lib/key-hint"

type Props = {
  onClose: () => void
}

type Shortcut = { keys: string; what: string }
type Group = { title: string; note?: string; rows: Shortcut[] }

/**
 * Grouped by where a binding is live, because most of them are not global: the
 * surface keys need a session, and the composer and panel keys only fire while
 * that thing has focus. A flat list read as if all twelve worked everywhere.
 */
const GROUPS: Group[] = [
  {
    title: "Anywhere",
    rows: [
      { keys: "⌘K", what: "Switch session — fuzzy over title / project / agent" },
      {
        keys: "⌃⇥",
        what: "Session switcher — hold ⌃ and tap ⇥ to cycle recent sessions, release to switch",
      },
      {
        keys: "⌥⇧U",
        what: "Next waiting — cycle the sessions that need you (waiting → failed → fresh done)",
      },
      {
        keys: "⌥⇧I",
        what: "Agent inbox — pending permissions, questions and failures across sessions",
      },
      { keys: "⌘N", what: "New session" },
      { keys: "⌘,", what: "Settings" },
      { keys: "⌘/", what: "Show or hide this list" },
      { keys: "⌘+", what: "Zoom in · ⌘− out · ⌘0 back to 100%" },
    ],
  },
  {
    title: "With a session open",
    note: "These need an active session; on the empty workspace they do nothing.",
    rows: [
      { keys: "⌘P", what: "Go to file — fuzzy over the project tree" },
      { keys: "⇧⌘F", what: "Search in project — content matches, jump to the line" },
      { keys: "⌘B", what: "Right panel — open it, or close it again" },
      {
        keys: "⌥⌘←/→",
        what: "Move between panes — drag a session onto a pane edge to split (⇧ moves the pane)",
      },
      { keys: "⌘G", what: "Diff panel — press again to close the panel" },
      { keys: "⌘Y", what: "History panel — press again to close the panel" },
      { keys: "⌘⌥1–9", what: "Run the project script bound to that digit" },
      { keys: "Esc", what: "Stop the running turn — when no dialog is open" },
    ],
  },
  {
    title: "In the composer",
    rows: [
      { keys: "Enter", what: "Send · ⇧Enter for a newline" },
      { keys: "⌘Enter", what: "Send from anywhere in the box" },
      { keys: "↑ ↓", what: "Walk back through prompts you already sent" },
      { keys: "⌘S", what: "Stash the draft to come back to" },
      { keys: "Esc", what: "Cancel a voice recording in progress" },
    ],
  },
  {
    title: "In the panels",
    rows: [
      { keys: "⌘S", what: "Save the open file or context document" },
      { keys: "⌘Enter", what: "Commit the staged files, in the Diff panel" },
      { keys: "← →", what: "Move a panel edge when its divider has focus" },
      { keys: "↩", what: "Reset a panel edge to its default width" },
    ],
  },
  {
    title: "In the image viewer",
    rows: [
      { keys: "← →", what: "Previous / next image" },
      { keys: "+ −", what: "Zoom the image" },
      { keys: "Esc", what: "Close the viewer" },
    ],
  },
]

/** Discoverability for the keymap — the bindings are useless if unlisted. */
export function ShortcutsOverlay({ onClose }: Props) {
  useOverlay({ onClose, exclusive: false })

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
          <p className="modal-lead">
            {hostPlatform() === "darwin"
              ? "Every binding the Hub owns. On Windows and Linux read ⌘ as Ctrl and ⌥ as Alt."
              : "Every binding the Hub owns."}
          </p>
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcut-group">
              <h3 className="shortcut-group-title">{group.title}</h3>
              {group.note ? (
                <p className="shortcut-group-note">{group.note}</p>
              ) : null}
              {group.rows.map((row) => (
                <div
                  key={`${group.title}:${row.keys}`}
                  className="shortcut-row"
                >
                  <span className="kbd">{keyHint(row.keys)}</span>
                  <span>{keyHint(row.what)}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
