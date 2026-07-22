import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import type { ChatMessage, ProviderId, ProviderInfo, SessionMeta } from "@shared/types"
import { formatClock } from "../lib/format"
import { MarkdownBody } from "./MarkdownBody"
import { TopBar } from "./TopBar"

type Props = {
  session: SessionMeta | null
  messages: ChatMessage[]
  providers: ProviderInfo[]
  provider: ProviderId
  error: string | null
  sending: boolean
  onProviderChange: (id: ProviderId) => void
  onSend: (text: string) => Promise<void>
  onAbort: () => void
  onCreate: () => void
}

export function ChatView({
  session,
  messages,
  providers,
  provider,
  error,
  sending,
  onProviderChange,
  onSend,
  onAbort,
  onCreate,
}: Props) {
  const [draft, setDraft] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, session?.id])

  useEffect(() => {
    setDraft("")
  }, [session?.id])

  async function submit() {
    const text = draft.trim()
    if (!text || !session || sending) return
    setDraft("")
    if (taRef.current) taRef.current.style.height = "auto"
    await onSend(text)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  function autoGrow() {
    const el = taRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  if (!session) {
    return (
      <main className="main">
        <div className="empty-workbench">
          <div className="empty-card">
            <div className="empty-kicker">Agent workbench</div>
            <h2>No session selected</h2>
            <p>
              Pick a thread in a project, or start a new agent turn. Status,
              streaming, and Monitor bridge stay event-driven from main.
            </p>
            <button type="button" className="tb-btn primary" onClick={onCreate}>
              New session
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="main">
      <TopBar session={session} onAbort={onAbort} />

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="transcript" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="transcript-empty">
            <p>Empty transcript</p>
            <span>Send a prompt — mock streams a dense agent reply.</span>
          </div>
        ) : (
          messages.map((m) => (
            <article key={m.id} className={`turn turn-${m.role}`}>
              {m.role === "user" ? (
                <>
                  <div className="turn-meta">
                    <span className="turn-role">You</span>
                    <span className="turn-time">{formatClock(m.createdAt)}</span>
                  </div>
                  <div className="user-bubble">{m.content}</div>
                </>
              ) : m.role === "system" ? (
                <div className="system-line">{m.content}</div>
              ) : (
                <>
                  <div className="turn-meta">
                    <span className="turn-role agent">Agent</span>
                    <span className="turn-provider">{session.provider}</span>
                    {m.streaming ? (
                      <span className="streaming-tag">streaming</span>
                    ) : (
                      <span className="turn-time">{formatClock(m.createdAt)}</span>
                    )}
                  </div>
                  <MarkdownBody text={m.content} streaming={m.streaming} />
                </>
              )}
            </article>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="composer-dock">
        <div className="composer-shell">
          <textarea
            ref={taRef}
            value={draft}
            placeholder="Ask for follow-up changes or attach images"
            rows={2}
            onChange={(e) => {
              setDraft(e.target.value)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
            disabled={sending && false}
          />
          <div className="composer-toolbar">
            <div className="composer-chips">
              <label className="chip select-chip">
                <span className="chip-ico">✦</span>
                <select
                  value={provider}
                  onChange={(e) =>
                    onProviderChange(e.target.value as ProviderId)
                  }
                  aria-label="Provider"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.label}
                      {!p.available ? " (soon)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <span className="chip muted">High · Normal</span>
              <span className="chip muted">Full access</span>
              <span className="chip muted">Build</span>
              <span className="chip muted">Tasks</span>
            </div>
            <button
              type="button"
              className="send-btn"
              onClick={() => void submit()}
              disabled={sending || !draft.trim()}
              aria-label="Send"
            >
              ↑
            </button>
          </div>
        </div>
        <div className="composer-footer">
          <span className="checkout">
            <span className="dot-green" /> Local checkout
          </span>
          <span className="branch mono-soft">{session.project} · main</span>
        </div>
      </div>
    </main>
  )
}
