import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import type { ChatMessage, SessionMeta } from "@shared/types"
import { StatusDot } from "./StatusDot"

type Props = {
  session: SessionMeta | null
  messages: ChatMessage[]
  error: string | null
  sending: boolean
  onSend: (text: string) => Promise<void>
  onAbort: () => void
}

export function ChatView({
  session,
  messages,
  error,
  sending,
  onSend,
  onAbort,
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
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }

  if (!session) {
    return (
      <main className="main">
        <div className="empty-state">
          <h3>Welcome to Chat Hub</h3>
          <p>
            Create a session from the sidebar. Start with the mock provider to
            exercise streaming, status events, and notifications — then wire a
            real adapter.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="main">
      <header className="chat-header">
        <div>
          <h2>{session.title}</h2>
          <div className="sub">
            {session.provider} · {session.cwd}
          </div>
        </div>
        <div className="header-actions">
          <span className="status-pill">
            <StatusDot status={session.status} />
            {session.status.replace("_", " ")}
          </span>
          {session.status === "running" ? (
            <button type="button" className="btn btn-ghost" onClick={onAbort}>
              Abort
            </button>
          ) : null}
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="messages" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty-state">
            <h3>Empty transcript</h3>
            <p>Send a message to get a streamed mock reply and status events.</p>
          </div>
        ) : (
          messages.map((m) => (
            <article key={m.id} className={`message ${m.role}`}>
              <div className="message-role">{m.role}</div>
              <div className={`bubble ${m.streaming ? "streaming" : ""}`}>
                {m.content || (m.streaming ? "" : "…")}
              </div>
            </article>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <div className="composer-inner">
          <textarea
            ref={taRef}
            value={draft}
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            rows={1}
            onChange={(e) => {
              setDraft(e.target.value)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
            disabled={sending}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={sending || !draft.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </main>
  )
}
