import { useMemo, useState, type KeyboardEvent } from "react"
import type { SessionMeta } from "@shared/types"
import { fuzzyScore } from "../lib/fuzzy"
import { formatRelative, statusLabel } from "../lib/format"

type Props = {
  sessions: SessionMeta[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}

/** ⌘K switcher: type a few letters of a project or title, Enter to jump. */
export function CommandPalette({
  sessions,
  activeId,
  onSelect,
  onClose,
}: Props) {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)

  const results = useMemo(() => {
    const scored: { session: SessionMeta; score: number }[] = []
    for (const s of sessions) {
      const score = fuzzyScore(query, `${s.title} ${s.project} ${s.provider}`)
      if (score !== null) scored.push({ session: s, score })
    }
    scored.sort(
      (a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt,
    )
    return scored.slice(0, 12).map((r) => r.session)
  }, [sessions, query])

  const clamped = Math.min(cursor, Math.max(results.length - 1, 0))

  function pick(id: string) {
    onSelect(id)
    onClose()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setCursor(Math.min(clamped + 1, results.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setCursor(Math.max(clamped - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const hit = results[clamped]
      if (hit) pick(hit.id)
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
            setCursor(0)
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" role="listbox">
          {results.length === 0 ? (
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
            results.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={i === clamped}
                className={`palette-row ${i === clamped ? "on" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(s.id)}
              >
                <span className="palette-title">{s.title}</span>
                <span className="palette-sub mono-soft">
                  {s.project} · {s.provider} · {statusLabel[s.status]}
                  {s.id === activeId ? " · current" : ""}
                </span>
                <span className="palette-time">{formatRelative(s.updatedAt)}</span>
              </button>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span className="kbd">↑↓</span> move
          <span className="kbd">↩</span> open
          <span className="kbd">esc</span> close
        </div>
      </div>
    </div>
  )
}
