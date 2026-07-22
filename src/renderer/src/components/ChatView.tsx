import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import type {
  ChatMessage,
  GitCheckoutInfo,
  ProviderId,
  ProviderInfo,
  SessionMeta,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import {
  PERMISSION_HINTS,
  PERMISSION_LABELS,
} from "@shared/permission"
import { formatClock } from "../lib/format"
import { MarkdownBody } from "./MarkdownBody"
import { TopBar } from "./TopBar"

type Props = {
  session: SessionMeta | null
  messages: ChatMessage[]
  providers: ProviderInfo[]
  provider: ProviderId
  permissionMode: PermissionMode
  git: GitCheckoutInfo | null
  error: string | null
  sending: boolean
  onProviderChange: (id: ProviderId) => void
  onPermissionChange: (mode: PermissionMode) => void
  onSend: (text: string) => Promise<void>
  onAbort: () => void
  onCreate: () => void
  onOpenFolder: () => void
  onOpenEditor: () => void
  onCommit: () => void
}

export function ChatView({
  session,
  messages,
  providers,
  provider,
  permissionMode,
  git,
  error,
  sending,
  onProviderChange,
  onPermissionChange,
  onSend,
  onAbort,
  onCreate,
  onOpenFolder,
  onOpenEditor,
  onCommit,
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
            <div className="empty-kicker">Daily agent workbench</div>
            <h2>Open a project to start</h2>
            <p>
              Pick a real folder and agent (Claude Code, Grok Build, OpenCode…).
              Sessions spawn the CLI in that directory with honest Working /
              Done status from process exit.
            </p>
            <button type="button" className="tb-btn primary" onClick={onCreate}>
              New session…
            </button>
          </div>
        </div>
      </main>
    )
  }

  const branchLabel =
    git && git.branch !== "no-git"
      ? `${git.branch}${git.dirty ? " *" : ""}`
      : "no-git"

  return (
    <main className="main">
      <TopBar
        session={session}
        git={git}
        onAbort={onAbort}
        onOpenFolder={onOpenFolder}
        onOpenEditor={onOpenEditor}
        onCommit={onCommit}
      />

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="transcript" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="transcript-empty">
            <p>Empty transcript</p>
            <span>
              Message goes to <strong>{session.provider}</strong> in{" "}
              <code>{session.cwd}</code>
            </span>
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
                      <span className="turn-time">
                        {formatClock(m.createdAt)}
                      </span>
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
            placeholder="Ask the agent… (Enter send · Shift+Enter newline)"
            rows={2}
            onChange={(e) => {
              setDraft(e.target.value)
              autoGrow()
            }}
            onKeyDown={onKeyDown}
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
                      {!p.available ? " (install CLI)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className={`chip select-chip perm-chip perm-${permissionMode}`}
                title={PERMISSION_HINTS[permissionMode]}
              >
                <select
                  value={permissionMode}
                  onChange={(e) =>
                    onPermissionChange(e.target.value as PermissionMode)
                  }
                  aria-label="Permission mode"
                >
                  {(["yolo", "acceptEdits", "default"] as PermissionMode[]).map(
                    (m) => (
                      <option key={m} value={m}>
                        {PERMISSION_LABELS[m]}
                        {m === "yolo" ? " · full access" : ""}
                      </option>
                    ),
                  )}
                </select>
              </label>
              {session.status === "running" ? (
                <button type="button" className="chip" onClick={onAbort}>
                  Stop
                </button>
              ) : null}
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
            <span className={git?.dirty ? "dot-amber" : "dot-green"} />
            Local checkout · {branchLabel}
          </span>
          <span className="branch mono-soft">
            {session.project} · {session.provider}
          </span>
        </div>
      </div>
    </main>
  )
}
