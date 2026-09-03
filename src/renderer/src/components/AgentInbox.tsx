import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { formatRelative } from "../lib/format"
import {
  inboxPrimaryAction,
  resolveInboxCursor,
  type InboxCard,
  type InboxCursor,
} from "../lib/inbox"

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

const KIND_LABEL: Record<InboxCard["kind"], string> = {
  permission: "permission",
  question: "question",
  failed: "failed",
}

type Props = {
  cards: InboxCard[]
  clearedToday: number
  onAllow: (requestId: string) => void
  onDeny: (requestId: string) => void
  onOpenSession: (sessionId: string) => void
  onCleared: (count: number) => void
  onClose: () => void
}

export function AgentInbox({
  cards,
  clearedToday,
  onAllow,
  onDeny,
  onOpenSession,
  onCleared,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const prevIdsRef = useRef<Set<string> | null>(null)
  const [cursor, setCursor] = useState<InboxCursor>({ key: null, index: 0 })

  const keys = useMemo(() => cards.map((card) => card.id), [cards])
  const active = resolveInboxCursor(keys, cursor)
  const focused = cards[active] ?? null

  const openChat = useCallback(
    (card: InboxCard) => {
      if (!card.sessionId) return
      onOpenSession(card.sessionId)
      onClose()
    },
    [onClose, onOpenSession],
  )

  const runPrimary = useCallback(
    (card: InboxCard) => {
      if (inboxPrimaryAction(card.kind) === "allow" && card.requestId) {
        onAllow(card.requestId)
        return
      }
      openChat(card)
    },
    [onAllow, openChat],
  )

  useEffect(() => {
    const ids = new Set(cards.map((card) => card.id))
    const prev = prevIdsRef.current
    prevIdsRef.current = ids
    if (!prev) return
    let removed = 0
    for (const id of prev) if (!ids.has(id)) removed += 1
    if (removed > 0 && document.hasFocus()) onCleared(removed)
  }, [cards, onCleared])

  useEffect(() => {
    const root = panelRef.current
    if (!root) return
    const id = keys[active]
    const target = id
      ? root.querySelector<HTMLElement>(`[data-inbox-id="${CSS.escape(id)}"]`)
      : root
    target?.focus()
  }, [active, keys])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = panelRef.current
      if (!root) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === "Tab") {
        const nodes = focusables(root)
        if (nodes.length === 0) {
          event.preventDefault()
          return
        }
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        const current = document.activeElement
        if (
          event.shiftKey &&
          (current === first || !root.contains(current))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (
          !event.shiftKey &&
          (current === last || !root.contains(current))
        ) {
          event.preventDefault()
          first?.focus()
        }
        return
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (keys.length === 0) return
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? 1 : -1
        const next = Math.min(Math.max(active + delta, 0), keys.length - 1)
        setCursor({ key: keys[next] ?? null, index: next })
        return
      }
      if (event.key !== "Enter" || !focused) return
      if (event.target instanceof HTMLButtonElement) return
      event.preventDefault()
      runPrimary(focused)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [active, focused, keys, onClose, runPrimary])

  function moveTo(index: number) {
    setCursor({ key: keys[index] ?? null, index })
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={panelRef}
        className="modal-panel inbox-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbox-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header inbox-header">
          <div className="inbox-header-copy">
            <h2 id="inbox-title">Agent inbox</h2>
            <span className="inbox-count" aria-live="polite">
              {cards.length === 1 ? "1 waiting" : `${cards.length} waiting`}
            </span>
          </div>
          <span className="inbox-esc">
            <span className="kbd">esc</span> close
          </span>
        </header>
        <div className="inbox-body" role="listbox" aria-label="Waiting items">
          {cards.length === 0 ? (
            <div className="inbox-empty">All clear</div>
          ) : (
            cards.map((card, index) => {
              const selected = index === active
              const canOpen = card.sessionId !== null
              const requestId = card.requestId
              return (
                <div
                  key={card.id}
                  data-inbox-id={card.id}
                  role="option"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  className={`inbox-card${selected ? " is-focused" : ""}`}
                  onMouseEnter={() => moveTo(index)}
                  onClick={() => moveTo(index)}
                >
                  <div className="inbox-card-top">
                    <span className="inbox-card-title">{card.title}</span>
                    <span className={`inbox-kind ${card.kind}`}>
                      {KIND_LABEL[card.kind]}
                    </span>
                  </div>
                  <div className="inbox-card-meta">
                    <span className="mono-soft">{card.project}</span>
                    <span className="sep">·</span>
                    <span className="inbox-age">{formatRelative(card.at)}</span>
                  </div>
                  <p className="inbox-card-body">{card.body}</p>
                  <div className="inbox-card-actions">
                    {card.kind === "permission" && requestId ? (
                      <>
                        <button
                          type="button"
                          className="tb-btn"
                          onClick={() => onDeny(requestId)}
                        >
                          Deny
                        </button>
                        <button
                          type="button"
                          className="tb-btn primary"
                          onClick={() => onAllow(requestId)}
                        >
                          Allow
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className={`tb-btn${
                        inboxPrimaryAction(card.kind) === "open"
                          ? " primary"
                          : ""
                      }`}
                      disabled={!canOpen}
                      onClick={() => openChat(card)}
                    >
                      Open chat
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
        <div className="inbox-foot">
          <span>Cleared today: {clearedToday}</span>
          <span className="inbox-foot-keys">
            <span className="kbd">↑↓</span> move
            <span className="kbd">↩</span> act
            <span className="kbd">esc</span> close
          </span>
        </div>
      </div>
    </div>
  )
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled"),
  )
}
