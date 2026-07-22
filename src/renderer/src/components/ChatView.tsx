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
import type { ModelInfo } from "@shared/settings-types"
import { formatClock } from "../lib/format"
import { MarkdownBody } from "./MarkdownBody"
import { TopBar } from "./TopBar"

type Effort = "low" | "medium" | "high" | "max"

type Props = {
  session: SessionMeta | null
  messages: ChatMessage[]
  providers: ProviderInfo[]
  provider: ProviderId
  models: ModelInfo[]
  permissionMode: PermissionMode
  git: GitCheckoutInfo | null
  error: string | null
  sending: boolean
  onProviderChange: (id: ProviderId) => void
  onModelChange: (model: string) => void
  onPermissionChange: (mode: PermissionMode) => void
  onSend: (
    text: string,
    opts?: { effort?: Effort; attachments?: string[] },
  ) => Promise<void>
  onAbort: () => void
  onCreate: () => void
  onOpenFolder: () => void
  onOpenEditor: () => void
  onCommit: () => void
  onRename: () => void
}

export function ChatView({
  session,
  messages,
  providers,
  provider,
  models,
  permissionMode,
  git,
  error,
  sending,
  onProviderChange,
  onModelChange,
  onPermissionChange,
  onSend,
  onAbort,
  onCreate,
  onOpenFolder,
  onOpenEditor,
  onCommit,
  onRename,
}: Props) {
  const [draft, setDraft] = useState("")
  const [effort, setEffort] = useState<Effort>("high")
  const [attachments, setAttachments] = useState<string[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, session?.id])

  useEffect(() => {
    setDraft("")
    setAttachments([])
  }, [session?.id])

  async function submit() {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || !session || sending) return
    setDraft("")
    const files = attachments
    setAttachments([])
    if (taRef.current) taRef.current.style.height = "auto"
    await onSend(text, { effort, attachments: files })
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

  async function attach() {
    const files = await window.chatHub.pickFiles()
    if (files.length) {
      setAttachments((curr) => [...curr, ...files])
    }
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
              Set model and YOLO in the new-session dialog or Settings (⌘,).
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

  const modelLabel =
    session.model ||
    models.find((m) => m.id === session.model)?.label ||
    "default"

  return (
    <main className="main">
      <TopBar
        session={session}
        git={git}
        onAbort={onAbort}
        onOpenFolder={onOpenFolder}
        onOpenEditor={onOpenEditor}
        onCommit={onCommit}
        onRename={onRename}
      />

      <div className="system-banner" title={session.cwd}>
        <span className="mono-soft">
          {session.provider}
          {session.model ? ` · ${session.model}` : ` · ${modelLabel}`}
          {` · ${permissionMode}`}
          {` · ${effort}`}
        </span>
        <span className="mono-soft dim">{session.cwd}</span>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="transcript" role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="transcript-empty">
            <p>Empty transcript</p>
            <span>
              Message goes to <strong>{session.provider}</strong>
              {session.model ? (
                <>
                  {" "}
                  · <code>{session.model}</code>
                </>
              ) : null}{" "}
              in <code>{session.cwd}</code>
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
        {attachments.length > 0 ? (
          <div className="attach-row">
            {attachments.map((f) => (
              <span key={f} className="attach-chip" title={f}>
                {f.split("/").pop()}
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((curr) => curr.filter((x) => x !== f))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
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
              {models.length > 0 ? (
                <label
                  className="chip select-chip"
                  title="Model for this session"
                >
                  <select
                    value={
                      session.model &&
                      models.some((m) => m.id === session.model)
                        ? session.model
                        : (models[0]?.id ?? "")
                    }
                    onChange={(e) => onModelChange(e.target.value)}
                    aria-label="Model"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
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
              <label className="chip select-chip" title="Effort (Claude)">
                <select
                  value={effort}
                  onChange={(e) => setEffort(e.target.value as Effort)}
                  aria-label="Effort"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="max">Max</option>
                </select>
              </label>
              <button type="button" className="chip" onClick={() => void attach()}>
                Attach
              </button>
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
              disabled={
                sending || (!draft.trim() && attachments.length === 0)
              }
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
