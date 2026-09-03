import { useMemo, useState, type KeyboardEvent } from "react"
import type { SessionMeta } from "@shared/types"
import {
  AGENT_INBOX_KEY,
  buildPaletteEntries,
  NEW_WINDOW_KEY,
  paletteKey,
  resolvePaletteCursor,
  type PaletteCursor,
  type PaletteEntry,
} from "../lib/palette"
import { formatRelative, statusLabel } from "../lib/format"

type Props = {
  sessions: SessionMeta[]
  activeId: string | null
  attentionCount: number
  inboxCount: number
  onSelect: (id: string) => void
  onNextAttention: () => void
  onNewWindow: (sessionId?: string) => void
  onOpenInbox: () => void
  onClose: () => void
}

/** ⌘K switcher: type a few letters of a project or title, Enter to jump. */
export function CommandPalette({
  sessions,
  activeId,
  attentionCount,
  inboxCount,
  onSelect,
  onNextAttention,
  onNewWindow,
  onOpenInbox,
  onClose,
}: Props) {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState<PaletteCursor>({ key: null, index: 0 })

  const entries = useMemo(
    () => buildPaletteEntries(sessions, query, attentionCount, inboxCount),
    [sessions, query, attentionCount, inboxCount],
  )
  const keys = useMemo(() => entries.map(paletteKey), [entries])
  const active = resolvePaletteCursor(keys, cursor)

  function moveTo(index: number) {
    setCursor({ key: keys[index] ?? null, index })
  }

  function pick(entry: PaletteEntry, newWindow = false) {
    if (entry.kind === "command") {
      if (entry.key === NEW_WINDOW_KEY) onNewWindow()
      else if (entry.key === AGENT_INBOX_KEY) onOpenInbox()
      else onNextAttention()
    } else if (newWindow) {
      onNewWindow(entry.session.id)
    } else {
      onSelect(entry.session.id)
    }
    onClose()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      moveTo(Math.min(active + 1, entries.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      moveTo(Math.max(active - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const hit = entries[active]
      if (hit) pick(hit, e.metaKey || e.ctrlKey)
    } else if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-panel palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Switch session"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          className="palette-input"
          value={query}
          autoFocus
          placeholder="Jump to session… (project or title)"
          aria-label="Search sessions"
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor({ key: null, index: 0 })
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" role="listbox">
          {entries.length === 0 ? (
            <div className="palette-empty">
              {sessions.length === 0 ? (
                <>
                  No sessions yet. Close this and press <span className="kbd">⌘N</span>{" "}
                  to start one.
                </>
              ) : (
                <>
                  Nothing matches <b>{query}</b> in titles, projects or agents.
                </>
              )}
            </div>
          ) : (
            entries.map((entry, i) => {
              const command = entry.kind === "command"
              return (
                <button
                  key={keys[i]}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`palette-row ${command ? "palette-cmd" : ""} ${
                    i === active ? "on" : ""
                  }`}
                  onMouseEnter={() => moveTo(i)}
                  onClick={(e) => pick(entry, e.metaKey || e.ctrlKey)}
                >
                  <span className="palette-title">
                    {command ? entry.label : entry.session.title}
                  </span>
                  <span className="palette-sub mono-soft">
                    {command
                      ? entry.sub
                      : `${entry.session.project} · ${entry.session.provider} · ${
                          statusLabel[entry.session.status]
                        }${entry.session.id === activeId ? " · current" : ""}`}
                  </span>
                  <span className={`palette-time ${command ? "kbd" : ""}`}>
                    {command ? entry.hint : formatRelative(entry.session.updatedAt)}
                  </span>
                </button>
              )
            })
          )}
        </div>
        <div className="palette-foot">
          <span className="kbd">↑↓</span> move
          <span className="kbd">↩</span> open
          <span className="kbd">⌘↩</span> new window
          <span className="kbd">esc</span> close
        </div>
      </div>
    </div>
  )
}
