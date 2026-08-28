import { useMemo, useState, type KeyboardEvent } from "react"
import type { SessionMeta } from "@shared/types"
import { fuzzyScore } from "../lib/fuzzy"
import { formatRelative, statusLabel } from "../lib/format"

type Props = {
  sessions: SessionMeta[]
  activeId: string | null
  attentionCount: number
  onSelect: (id: string) => void
  onNextAttention: () => void
  onClose: () => void
}

type Entry =
  | { kind: "command"; label: string; sub: string }
  | { kind: "session"; session: SessionMeta }

/** ⌘K switcher: type a few letters of a project or title, Enter to jump. */
export function CommandPalette({
  sessions,
  activeId,
  attentionCount,
  onSelect,
  onNextAttention,
  onClose,
}: Props) {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)

  const results = useMemo<Entry[]>(() => {
    const scored: { session: SessionMeta; score: number }[] = []
    for (const s of sessions) {
      const score = fuzzyScore(query, `${s.title} ${s.project} ${s.provider}`)
      if (score !== null) scored.push({ session: s, score })
    }
    scored.sort(
      (a, b) => b.score - a.score || b.session.updatedAt - a.session.updatedAt,
    )
    const out: Entry[] = []
    if (
      attentionCount > 0 &&
      fuzzyScore(query, "next waiting needs you attention jump") !== null
    ) {
      out.push({
        kind: "command",
        label: "Next waiting",
        sub: `Jump to the next session that needs you · ${attentionCount} in queue`,
      })
    }
    for (const r of scored.slice(0, 12)) {
      out.push({ kind: "session", session: r.session })
    }
    return out
  }, [sessions, query, attentionCount])

  const clamped = Math.min(cursor, Math.max(results.length - 1, 0))

  function pick(entry: Entry) {
    if (entry.kind === "command") onNextAttention()
    else onSelect(entry.session.id)
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
      if (hit) pick(hit)
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
            results.map((entry, i) =>
              entry.kind === "command" ? (
                <button
                  key="command:next-attention"
                  type="button"
                  role="option"
                  aria-selected={i === clamped}
                  className={`palette-row palette-cmd ${i === clamped ? "on" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(entry)}
                >
                  <span className="palette-title">{entry.label}</span>
                  <span className="palette-sub mono-soft">{entry.sub}</span>
                  <span className="palette-time kbd">⌥⇧U</span>
                </button>
              ) : (
                <button
                  key={entry.session.id}
                  type="button"
                  role="option"
                  aria-selected={i === clamped}
                  className={`palette-row ${i === clamped ? "on" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(entry)}
                >
                  <span className="palette-title">{entry.session.title}</span>
                  <span className="palette-sub mono-soft">
                    {entry.session.project} · {entry.session.provider} ·{" "}
                    {statusLabel[entry.session.status]}
                    {entry.session.id === activeId ? " · current" : ""}
                  </span>
                  <span className="palette-time">
                    {formatRelative(entry.session.updatedAt)}
                  </span>
                </button>
              ),
            )
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
