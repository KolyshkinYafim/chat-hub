import { useEffect, useMemo, useRef, useState } from "react"
import type { SessionMeta } from "@shared/types"
import { formatRelative, statusLabel } from "../lib/format"
import { keyHint } from "../lib/key-hint"
import {
  commitTarget,
  cycleIndex,
  filterByQuery,
  initialCursor,
} from "../lib/session-switcher"

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        e.preventDefault()
        e.stopPropagation()
        const length = visibleRef.current.length
        setCursor((curr) => cycleIndex(curr, e.shiftKey ? -1 : 1, length))
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        e.stopPropagation()
        const hit = commitTarget(visibleRef.current, clampedRef.current)
        if (hit) onCommit(hit.id)
        else onCancel()
        return
      }
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
      const hit = commitTarget(visibleRef.current, clampedRef.current)
      if (hit) onCommit(hit.id)
      else onCancel()
    }
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp, true)
    window.addEventListener("blur", onCancel)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp, true)
      window.removeEventListener("blur", onCancel)
    }
  }, [onCancel, onCommit])

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
