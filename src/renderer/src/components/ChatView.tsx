import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type UIEvent,
} from "react"
import type {
  ChatMessage,
  GitCheckoutInfo,
  PermissionRequestInfo,
  ProviderInfo,
  QueuedMessage,
  SessionMeta,
  SessionUsage,
  TurnUsage,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import {
  PERMISSION_HINTS,
  PERMISSION_LABELS,
} from "@shared/permission"
import type { Mode, ModelInfo } from "@shared/settings-types"
import { formatClock } from "../lib/format"
import { formatSessionUsage, formatUsage, usageDetail } from "../lib/usage"
import { MarkdownBody } from "./MarkdownBody"
import { TopBar } from "./TopBar"

type Effort = "low" | "medium" | "high" | "max"

/** The auth nag, rendered inline so it never outweighs the session title. */
export type OnboardNotice = {
  text: string
  onOpenSettings: () => void
  onDismiss: () => void
}

type Props = {
  session: SessionMeta | null
  onboard: OnboardNotice | null
  /** Message the sidebar search asked us to reveal; cleared once scrolled to. */
  highlightMessageId: string | null
  onHighlightShown: () => void
  /** Running cost/token totals; null when no CLI on this session reports them. */
  usage: SessionUsage | null
  pendingPermissions: PermissionRequestInfo[]
  onResolvePermission: (requestId: string, allow: boolean) => void
  messages: ChatMessage[]
  providers: ProviderInfo[]
  models: ModelInfo[]
  modes: Mode[]
  onApplyMode: (modeId: string) => void
  permissionMode: PermissionMode
  effort: Effort
  git: GitCheckoutInfo | null
  error: string | null
  sending: boolean
  queued: QueuedMessage[]
  onCancelQueued: (id: string) => void
  onShowShortcuts: () => void
  onModelChange: (model: string) => void
  onPermissionChange: (mode: PermissionMode) => void
  onEffortChange: (effort: Effort) => void
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

/** Per-turn cost, folded into the agent turn's meta row. */
function TurnCost({ usage }: { usage: TurnUsage }) {
  const label = formatUsage(usage)
  if (!label) return null
  return (
    <span className="turn-cost" title={usageDetail(usage)}>
      {label}
    </span>
  )
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

/** Attachment pill: shows an inline thumbnail for images, click opens the lightbox. */
function AttachChip({
  path,
  onRemove,
  onPreview,
}: {
  path: string
  onRemove: () => void
  onPreview: (url: string) => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const isImage = IMAGE_EXT.test(path)
  useEffect(() => {
    if (!isImage) return
    let alive = true
    void window.chatHub.readImageDataUrl(path).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [path, isImage])
  return (
    <span className={`attach-chip ${url ? "has-thumb" : ""}`} title={path}>
      {url ? (
        <img
          className="attach-thumb"
          src={url}
          alt=""
          onClick={() => onPreview(url)}
        />
      ) : null}
      <span className="attach-name">{path.split("/").pop()}</span>
      <button type="button" title="Remove" onClick={onRemove}>
        ×
      </button>
    </span>
  )
}

export function ChatView({
  session,
  onboard,
  highlightMessageId,
  onHighlightShown,
  usage,
  pendingPermissions,
  onResolvePermission,
  messages,
  providers,
  models,
  modes,
  onApplyMode,
  permissionMode,
  effort,
  git,
  error,
  sending,
  queued,
  onCancelQueued,
  onShowShortcuts,
  onModelChange,
  onPermissionChange,
  onEffortChange,
  onSend,
  onAbort,
  onCreate,
  onOpenFolder,
  onOpenEditor,
  onCommit,
  onRename,
}: Props) {
  const [draft, setDraft] = useState("")
  const [attachments, setAttachments] = useState<string[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)
  const flashedRef = useRef<string | null>(null)
  // -1 means the live draft; anything else indexes into `promptHistory`.
  const [histIndex, setHistIndex] = useState(-1)
  const liveDraftRef = useRef("")

  // Oldest→newest list of what you actually sent this session — the shell-style
  // ↑/↓ recall reads from it so you can re-run a prompt without retyping.
  const promptHistory = useMemo(
    () => messages.filter((m) => m.role === "user").map((m) => m.content),
    [messages],
  )

  useEffect(() => {
    setDraft("")
    setAttachments([])
    setHistIndex(-1)
    atBottomRef.current = true
    setAtBottom(true)
  }, [session?.id])

  // Programmatic draft changes (history recall, send-clear) also need the
  // textarea to resize; keeping it here covers every path, not just typing.
  useEffect(() => {
    autoGrow()
  }, [draft])

  useEffect(() => {
    // Deltas arrive per token; yanking the view down on each one makes the
    // scrollback unreadable while an agent works. Only follow if pinned.
    if (!atBottomRef.current) return
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [messages, session?.id])

  useEffect(() => {
    // Re-run on `messages` too: a jump into a session whose transcript is still
    // being fetched finds no element on the first pass and must retry once it
    // arrives — `flashedRef` keeps the retry from re-firing on every delta.
    if (!highlightMessageId) {
      flashedRef.current = null
      return
    }
    if (flashedRef.current === highlightMessageId) return
    const el = transcriptRef.current?.querySelector(
      `[data-mid="${CSS.escape(highlightMessageId)}"]`,
    )
    if (!el) return
    flashedRef.current = highlightMessageId
    // Landing mid-scrollback means we are no longer tailing; say so before the
    // scroll fires, or the next delta yanks the user away from the hit.
    atBottomRef.current = false
    setAtBottom(false)
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    el.classList.add("hit-flash")
    const timer = window.setTimeout(() => {
      el.classList.remove("hit-flash")
      onHighlightShown()
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [highlightMessageId, messages, onHighlightShown])

  function onTranscriptScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64
    atBottomRef.current = near
    setAtBottom((curr) => (curr === near ? curr : near))
  }

  function jumpToLatest() {
    atBottomRef.current = true
    setAtBottom(true)
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }

  async function submit() {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || !session || sending) return
    const files = attachments
    setDraft("")
    setAttachments([])
    setHistIndex(-1)
    if (taRef.current) taRef.current.style.height = "auto"
    try {
      // Paths travel as opts, not as prose: main validates each one exists and
      // the adapters fold them in with the syntax their own CLI reads.
      await onSend(text, {
        effort,
        attachments: files.length > 0 ? files : undefined,
      })
    } catch {
      // Send failed before it reached the agent — hand the prompt back.
      setDraft(text)
      setAttachments(files)
    }
  }

  function recallHistory(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const el = e.currentTarget
    if (promptHistory.length === 0) return false
    // Only hijack the arrow at a text boundary, so multi-line editing with the
    // arrows keeps working — up from the top line, down from the bottom line.
    if (e.key === "ArrowUp") {
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0
      if (!atStart) return false
      if (histIndex === -1) liveDraftRef.current = draft
      const next =
        histIndex === -1 ? promptHistory.length - 1 : Math.max(0, histIndex - 1)
      setHistIndex(next)
      setDraft(promptHistory[next])
      return true
    }
    if (e.key === "ArrowDown") {
      if (histIndex === -1) return false
      const atEnd =
        el.selectionStart === el.value.length &&
        el.selectionEnd === el.value.length
      if (!atEnd) return false
      if (histIndex >= promptHistory.length - 1) {
        setHistIndex(-1)
        setDraft(liveDraftRef.current)
      } else {
        setHistIndex(histIndex + 1)
        setDraft(promptHistory[histIndex + 1])
      }
      return true
    }
    return false
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && recallHistory(e)) {
      e.preventDefault()
      return
    }
    if (e.key !== "Enter") return
    // ⌘Enter sends from anywhere in the draft; Shift+Enter stays a newline.
    if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return
    e.preventDefault()
    void submit()
  }

  async function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    // Screenshots arrive as image "file" items with no path; save each to disk
    // and attach it. Text paste falls through to the textarea untouched.
    const items = e.clipboardData?.items
    if (!items) return
    const images = Array.from(items).filter(
      (it) => it.kind === "file" && it.type.startsWith("image/"),
    )
    if (images.length === 0) return
    e.preventDefault()
    for (const it of images) {
      const file = it.getAsFile()
      if (!file) continue
      const ext = file.type.split("/")[1]?.split("+")[0] || "png"
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const path = await window.chatHub.savePastedImage(bytes, ext)
        setAttachments((curr) =>
          curr.includes(path) ? curr : [...curr, path],
        )
      } catch {
        // A single failed paste should not eat the others or the draft.
      }
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
        {onboard ? (
          <div className="onboard-strip">
            <span className="onboard-text">{onboard.text}</span>
            <button
              type="button"
              className="link-btn"
              onClick={onboard.onOpenSettings}
            >
              Open Settings
            </button>
            <button
              type="button"
              className="onboard-close"
              title="Dismiss"
              onClick={onboard.onDismiss}
            >
              ×
            </button>
          </div>
        ) : null}
        <div className="empty-workbench">
          <div className="empty-card">
            <div className="empty-kicker">Daily agent workbench</div>
            <h2>Open a project to start</h2>
            <p>
              Pick a real folder and agent (Claude Code, Grok Build, OpenCode…).
              Set model and YOLO in the new-session dialog or Settings (⌘,).
            </p>
            <button type="button" className="tb-btn primary" onClick={onCreate}>
              New session… <span className="kbd">⌘N</span>
            </button>
            <button type="button" className="link-btn" onClick={onShowShortcuts}>
              Keyboard shortcuts <span className="kbd">⌘/</span>
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
    models.find((m) => m.id === session.model)?.label ??
    session.model ??
    "CLI default"
  // Effort is a Claude Code flag; no other adapter passes it on.
  const supportsEffort = session.provider === "claude"
  const running = session.status === "running"
  const usageLabel = usage ? formatSessionUsage(usage) : null

  return (
    <main className="main">
      <TopBar
        session={session}
        git={git}
        onOpenFolder={onOpenFolder}
        onOpenEditor={onOpenEditor}
        onCommit={onCommit}
        onRename={onRename}
      />

      <div className="system-banner" title={session.cwd}>
        <span className="mono-soft">
          {session.provider}
          {` · ${modelLabel}`}
          {` · ${permissionMode}`}
          {supportsEffort ? ` · ${effort}` : ""}
        </span>
        <span className="mono-soft dim">{session.cwd}</span>
      </div>

      {onboard ? (
        <div className="onboard-strip">
          <span className="onboard-text">{onboard.text}</span>
          <button
            type="button"
            className="link-btn"
            onClick={onboard.onOpenSettings}
          >
            Open Settings
          </button>
          <button
            type="button"
            className="onboard-close"
            title="Dismiss"
            onClick={onboard.onDismiss}
          >
            ×
          </button>
        </div>
      ) : null}

      {permissionMode === "default" ? (
        <div className="warn-banner">
          Ask mode — Chat Hub cannot answer a tool prompt yet, so a turn that
          hits one stalls until you Stop it. YOLO or Edits keep turns moving.
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      {pendingPermissions.map((req) => (
        <div key={req.requestId} className="permission-banner">
          <span className="permission-tag">Approval needed</span>
          <span className="permission-summary" title={req.cwd ?? session.cwd}>
            {req.toolName ? `${req.toolName} · ` : ""}
            {req.summary}
          </span>
          <div className="permission-actions">
            <button
              type="button"
              className="tb-btn"
              onClick={() => onResolvePermission(req.requestId, false)}
            >
              Deny
            </button>
            <button
              type="button"
              className="tb-btn primary"
              onClick={() => onResolvePermission(req.requestId, true)}
            >
              Allow
            </button>
          </div>
          {/* The island answers the same request over the same socket, so
              whichever window is in front wins and the other card disappears. */}
          <span className="permission-where">or answer in the notch island</span>
        </div>
      ))}

      <div
        className="transcript"
        role="log"
        aria-live="polite"
        ref={transcriptRef}
        onScroll={onTranscriptScroll}
      >
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
            <article
              key={m.id}
              data-mid={m.id}
              className={`turn turn-${m.role}`}
            >
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
                    {/* No STREAMING tag: the caret at the end of the body is
                        already saying it, right where the eye is. */}
                    {m.streaming ? null : (
                      <span className="turn-time">
                        {formatClock(m.createdAt)}
                      </span>
                    )}
                    {m.usage ? <TurnCost usage={m.usage} /> : null}
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
        {!atBottom ? (
          <button type="button" className="jump-latest" onClick={jumpToLatest}>
            ↓ Jump to latest
          </button>
        ) : null}
        {queued.length > 0 ? (
          <div className="queued-row">
            {queued.map((q, i) => (
              <span key={q.id} className="queued-chip" title={q.text}>
                <span className="queued-tag">queued {i + 1}</span>
                <span className="queued-text">{q.text}</span>
                <button
                  type="button"
                  title="Cancel this queued message"
                  onClick={() => onCancelQueued(q.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="attach-row">
            {attachments.map((f) => (
              <AttachChip
                key={f}
                path={f}
                onRemove={() =>
                  setAttachments((curr) => curr.filter((x) => x !== f))
                }
                onPreview={setPreview}
              />
            ))}
          </div>
        ) : null}
        <div className="composer-shell">
          <textarea
            ref={taRef}
            value={draft}
            placeholder={
              running
                ? "Agent is working — Enter queues this for the next turn (Esc stops)"
                : "Ask the agent… (Enter send · Shift+Enter newline)"
            }
            rows={2}
            onChange={(e) => {
              // Typing over a recalled prompt drops you back to a live draft.
              if (histIndex !== -1) setHistIndex(-1)
              setDraft(e.target.value)
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => void onPaste(e)}
          />
          <div className="composer-toolbar">
            <div className="composer-chips">
              {/* Session-bound agent — not the global "default for new" */}
              <span className="chip select-chip locked" title="Agent for this session">
                <span className="chip-ico">✦</span>
                {providers.find((p) => p.id === session.provider)?.label ??
                  session.provider}
              </span>
              {models.length > 0 ? (
                <label
                  className="chip select-chip"
                  title="Model for this session"
                >
                  {/* Bound to the session as it really is: an unset model runs
                      the CLI default, and showing models[0] instead was a lie
                      the user could not even click away. */}
                  <select
                    value={session.model ?? ""}
                    onChange={(e) => onModelChange(e.target.value)}
                    aria-label="Model"
                  >
                    <option value="">CLI default</option>
                    {session.model &&
                    !models.some((m) => m.id === session.model) ? (
                      <option value={session.model}>
                        {session.model} · not probed
                      </option>
                    ) : null}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="chip muted">default model</span>
              )}
              {modes.length > 0 ? (
                <label
                  className={`chip select-chip ${session.modeId ? "mode-on" : ""}`}
                  title="Mode preset — appends a system prompt (+ model/effort/permission) to this session"
                >
                  <span className="chip-ico">◈</span>
                  <select
                    value={session.modeId ?? ""}
                    onChange={(e) => onApplyMode(e.target.value)}
                    aria-label="Mode"
                  >
                    <option value="">No mode</option>
                    {modes.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label
                className={`chip select-chip perm-chip perm-${permissionMode}`}
                title={`${PERMISSION_HINTS[permissionMode]} · applies to every session`}
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
              <label
                className={`chip select-chip ${supportsEffort ? "" : "muted"}`}
                title={
                  supportsEffort
                    ? "Reasoning effort (Claude Code)"
                    : `Only Claude Code takes an effort flag — ${session.provider} ignores it`
                }
              >
                <select
                  value={effort}
                  disabled={!supportsEffort}
                  onChange={(e) => onEffortChange(e.target.value as Effort)}
                  aria-label="Effort"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="max">Max</option>
                </select>
              </label>
            </div>
            {/* Chips above are session state; everything here performs an
                action, so they do not share a weight. */}
            <div className="composer-actions">
              <button
                type="button"
                className="composer-action"
                title="Attach files — their paths are added to the prompt"
                onClick={() => void attach()}
              >
                <span aria-hidden>＋</span> Attach
              </button>
              {running ? (
                <button
                  type="button"
                  className="composer-action danger"
                  title="Stop this turn (Esc)"
                  onClick={onAbort}
                >
                  <span aria-hidden>■</span> Stop
                </button>
              ) : null}
              <button
                type="button"
                className={`send-btn ${running ? "queueing" : ""}`}
                onClick={() => void submit()}
                disabled={
                  sending || (!draft.trim() && attachments.length === 0)
                }
                aria-label={running ? "Queue message" : "Send"}
                title={
                  running
                    ? "Agent is working — this is queued until the turn ends"
                    : "Send (Enter · ⌘Enter)"
                }
              >
                {running ? "⏱" : "↑"}
              </button>
            </div>
          </div>
        </div>
        <div className="composer-footer">
          <span className="checkout">
            <span className={git?.dirty ? "dot-amber" : "dot-green"} />
            Local checkout · {branchLabel}
          </span>
          {usageLabel && usage ? (
            <span
              className="usage-chip mono-soft"
              title={`Session total · ${usageDetail(usage)}`}
            >
              {usageLabel}
            </span>
          ) : null}
          <span className="branch mono-soft">
            {session.project} · {session.provider}
            <button
              type="button"
              className="link-btn"
              title="Keyboard shortcuts"
              onClick={onShowShortcuts}
            >
              <span className="kbd">⌘/</span>
            </button>
          </span>
        </div>
      </div>
      {preview ? (
        <div
          className="lightbox"
          role="presentation"
          onClick={() => setPreview(null)}
        >
          <img src={preview} alt="attachment preview" />
          <button
            type="button"
            className="lightbox-close"
            title="Close (click anywhere)"
            onClick={() => setPreview(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </main>
  )
}
