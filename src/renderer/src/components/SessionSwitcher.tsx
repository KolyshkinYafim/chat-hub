import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SessionMeta } from "@shared/types"
import { formatRelative, statusLabel } from "../lib/format"
import { keyHint } from "../lib/key-hint"
import {
  commitTarget,
  filterByQuery,
  initialCursor,
} from "../lib/session-switcher"
import { useOverlay } from "../lib/use-overlay"

type Props = {
  sessions: SessionMeta[]
  activeId: string | null
  onCommit: (id: string) => void
  onCancel: () => void
}

export function SessionSwitcher({
  sessions,
  activeId,
  onCommit,
  onCancel,
}: Props) {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(() => initialCursor(sessions.length))

  const visible = useMemo(
    () => filterByQuery(sessions, query),
    [sessions, query],
  )
  const clamped = Math.min(cursor, Math.max(visible.length - 1, 0))

  const visibleRef = useRef(visible)
  const clampedRef = useRef(clamped)
  visibleRef.current = visible
  clampedRef.current = clamped

  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [clamped, visible])

  const commit = useCallback(() => {
    const hit = commitTarget(visibleRef.current, clampedRef.current)
    if (hit) onCommit(hit.id)
    else onCancel()
  }, [onCancel, onCommit])

  useOverlay({
    onClose: onCancel,
    cursor: {
      count: visible.length,
      active: clamped,
      onMove: setCursor,
      keys: "tab",
      onCommit: (e) => {
        e.preventDefault()
        e.stopPropagation()
        commit()
      },
    },
  })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Backspace") {
        e.stopPropagation()
        setQuery((curr) => curr.slice(0, -1))
        setCursor(0)
        return
      }
      if (e.key.length === 1 && !e.metaKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        setQuery((curr) => curr + e.key)
        setCursor(0)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Control") return
      e.preventDefault()
      commit()
    }
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp, true)
    window.addEventListener("blur", onCancel)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp, true)
      window.removeEventListener("blur", onCancel)
    }
  }, [commit, onCancel])

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        className="modal-panel palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Session switcher"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="switcher-head">
          {query ? (
            <span className="switcher-query">{query}</span>
          ) : (
            <span className="switcher-hint">
              Hold <span className="kbd">ctrl</span>, press{" "}
              <span className="kbd">tab</span> to cycle — type to filter
            </span>
          )}
        </div>
        <div className="palette-list" role="listbox" ref={listRef}>
          {visible.length === 0 ? (
            <div className="palette-empty">
              Nothing matches <b>{query}</b> in titles, projects or agents.
            </div>
          ) : (
            visible.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={i === clamped}
                className={`palette-row ${i === clamped ? "on" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onCommit(s.id)}
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
          <span className="kbd">{keyHint("⇥")}</span> next
          <span className="kbd">{keyHint("⇧⇥")}</span> previous
          <span className="kbd">release ctrl</span> switch
          <span className="kbd">esc</span> cancel
        </div>
      </div>
    </div>
  )
}
