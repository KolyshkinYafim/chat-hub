import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type UIEvent,
} from "react"
import type {
  AgentTurnItem,
  AgentInputRequestInfo,
  ChatMessage,
  GitCheckoutInfo,
  MessageAttachment,
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
import { PlanSteps, toPlanSteps } from "./PlanSteps"
import { formatSessionUsage, formatUsage, usageDetail } from "../lib/usage"
import { MarkdownBody } from "./MarkdownBody"
import { TopBar } from "./TopBar"
import { AttachmentGallery } from "./AttachmentGallery"
import { AttachmentLightbox } from "./AttachmentLightbox"

type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

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
  pendingInputRequests: AgentInputRequestInfo[]
  onResolveInput: (requestId: string, answers: Record<string, string[]>) => void
  messages: ChatMessage[]
  /** True when the session has older turns in the on-disk overflow archive. */
  hasOlderMessages?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => void
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
  /** A path from a turn's changed-files row — opens it in the Diff surface. */
  onOpenDiff: (path: string) => void
  dockOpen: boolean
  onToggleDock: () => void
}

type ComposerDraft = {
  text: string
  attachments: MessageAttachment[]
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

function itemLabel(item: AgentTurnItem): string {
  switch (item.kind) {
    case "reasoning": return "Reasoning"
    case "plan": return "Plan"
    case "command": return item.command.split("\n")[0] || "Command"
    case "file_change": {
      if (item.changes.length === 0) {
        return item.status === "running"
          ? item.aggregateDiff ? "Preparing diff" : "Preparing file changes"
          : "No file changes"
      }
      return item.changes.length === 1 ? item.changes[0]!.path : `${item.changes.length} file changes`
    }
    case "tool": return item.server ? `${item.server} · ${item.name}` : item.name
    case "web_search": return `Search · ${item.query}`
    case "image": return `Viewed · ${item.path}`
    case "review": return "Review"
    case "compaction": return "Context compacted"
    case "error": return "Error"
  }
}

function liveActionLabel(item: AgentTurnItem): string {
  switch (item.kind) {
    case "plan": {
      const step = item.steps?.find((candidate) => candidate.status === "running")
        ?? item.steps?.find((candidate) => candidate.status === "pending")
      return step?.text || item.text || "Updating plan"
    }
    case "command": return `Running ${item.command.split("\n")[0] || "command"}`
    case "file_change": return item.changes.length
      ? `Changing ${item.changes.length === 1 ? item.changes[0]!.path : `${item.changes.length} files`}`
      : item.aggregateDiff ? "Preparing the code diff" : "Preparing file changes"
    case "tool": return `Using ${item.server ? `${item.server} · ` : ""}${item.name}`
    case "web_search": return `Searching for ${item.query}`
    case "image": return `Inspecting ${item.path}`
    case "review": return item.text || "Reviewing changes"
    case "compaction": return "Compacting context"
    case "reasoning": return "Preparing the next step"
    case "error": return item.message
  }
}

function itemHasDetail(item: AgentTurnItem): boolean {
  if (item.kind === "command") return Boolean(item.command || item.output)
  if (item.kind === "file_change") return item.changes.length > 0 || Boolean(item.aggregateDiff)
  if (item.kind === "tool") return Boolean(item.result ?? item.arguments ?? item.error)
  if (item.kind === "plan") return Boolean(item.text || item.steps?.length)
  return item.kind === "review" || item.kind === "error" || item.kind === "reasoning"
}

function ItemBody({ item }: { item: AgentTurnItem }) {
  switch (item.kind) {
    case "reasoning":
      return <div className="activity-text">{item.summary}</div>
    case "plan":
      return item.steps?.length ? (
        <PlanSteps
          steps={toPlanSteps(item.steps)}
          title={item.text ? `Planning: ${item.text}` : undefined}
          expandKey={`turn-${item.id}`}
          defaultOpen
        />
      ) : <div className="activity-text">{item.text}</div>
    case "command":
      return (
        <>
          <pre className="activity-code"><code>$ {item.command}</code></pre>
          {item.output ? <pre className="activity-output"><code>{item.output}</code></pre> : null}
        </>
      )
    case "file_change": {
      const diff = item.aggregateDiff || item.changes.map((change) => change.diff).filter(Boolean).join("\n")
      return (
        <>
          {item.changes.length ? <div className="activity-files">{item.changes.map((change) => <span key={change.path}>{change.kind ?? "edit"} · {change.path}</span>)}</div> : null}
          {diff ? <pre className="activity-diff"><code>{diff}</code></pre> : null}
        </>
      )
    }
    case "tool":
      return <pre className="activity-code"><code>{JSON.stringify(item.result ?? item.arguments ?? item.error ?? {}, null, 2)}</code></pre>
    case "review": return <div className="activity-text">{item.text}</div>
    case "error": return <div className="activity-error">{item.message}</div>
    default: return null
  }
}

function TurnItems({
  items,
  streaming = false,
}: {
  items: AgentTurnItem[] | undefined
  streaming?: boolean
}) {
  if (!items?.length) return streaming ? <LiveActivityPlaceholder /> : null
  const reasoning = items.filter((item) => item.kind === "reasoning")
  const activity = items.filter((item) => item.kind !== "reasoning")
  return (
    <div className="turn-activity">
      {reasoning.length ? <ReasoningGroup items={reasoning} /> : null}
      {activity.length ? <ActivityOverview items={activity} /> : streaming ? <LiveActivityPlaceholder /> : null}
      {activity.map((item) => (
        <details
          key={item.id}
          className={`activity-item activity-${item.kind}`}
          open={item.kind === "error" || (item.status === "running" && itemHasDetail(item))}
        >
          <summary>
            <span className={`activity-status status-${item.status}`} aria-label={item.status} />
            <span className="activity-label">{itemLabel(item)}</span>
            <span className="activity-state">{item.status}</span>
          </summary>
          <ItemBody item={item} />
        </details>
      ))}
    </div>
  )
}

function LiveActivityPlaceholder() {
  return (
    <div className="activity-live" aria-live="polite">
      <span className="activity-status status-running" aria-label="running" />
      <span className="activity-live-kicker">Working now</span>
      <strong className="activity-live-label">Preparing the next step</strong>
      <span className="activity-state">live</span>
    </div>
  )
}

/** A readable outcome before the detailed, chronological tool cards. */
function ActivityOverview({ items }: { items: Exclude<AgentTurnItem, { kind: "reasoning" }>[] }) {
  const commands = items.filter((item) => item.kind === "command").length
  const files = items
    .filter((item): item is Extract<AgentTurnItem, { kind: "file_change" }> => item.kind === "file_change")
    .reduce((total, item) => total + item.changes.length, 0)
  const tools = items.filter((item) => item.kind === "tool" || item.kind === "web_search" || item.kind === "image").length
  const plans = items.filter((item) => item.kind === "plan" || item.kind === "review").length
  const failed = items.filter((item) => item.status === "failed" || item.status === "declined" || item.status === "interrupted").length
  const running = items.some((item) => item.status === "running" || item.status === "pending")
  const parts = [
    commands ? `${commands} ${commands === 1 ? "command" : "commands"}` : "",
    files ? `${files} ${files === 1 ? "file" : "files"}` : "",
    tools ? `${tools} ${tools === 1 ? "tool" : "tools"}` : "",
    plans ? `${plans} ${plans === 1 ? "plan update" : "plan updates"}` : "",
  ].filter(Boolean)
  const status = failed ? "failed" : running ? "running" : "completed"
  const live = [...items].reverse().find((item) => item.status === "running" || item.status === "pending")
  return (
    <>
      {live ? (
        <div className="activity-live" aria-live="polite">
          <span className="activity-status status-running" aria-label="running" />
          <span className="activity-live-kicker">Working now</span>
          <strong className="activity-live-label">{liveActionLabel(live)}</strong>
          <span className="activity-state">live</span>
        </div>
      ) : null}
      <div className="activity-overview">
        <span className={`activity-status status-${status}`} aria-label={status} />
        <span className="activity-label">Technical activity</span>
        <span className="activity-overview-summary">{parts.join(" · ") || `${items.length} updates`}</span>
        <span className="activity-state">{failed ? `${failed} failed` : status}</span>
      </div>
    </>
  )
}

/** Keep a long Codex turn readable: it streams several safe reasoning summaries. */
function ReasoningGroup({ items }: { items: Extract<AgentTurnItem, { kind: "reasoning" }>[] }) {
  const summaries = [...new Set(items.map((item) => cleanReasoning(item.summary)).filter(Boolean))]
  const status = items.some((item) => item.status === "running")
    ? "running"
    : items.some((item) => item.status === "failed" || item.status === "interrupted")
      ? "failed"
      : "completed"
  return (
    <details className="activity-item activity-reasoning" open={status === "running"}>
      <summary>
        <span className={`activity-status status-${status}`} aria-label={status} />
        <span className="activity-label">Reasoning{summaries.length > 1 ? ` · ${summaries.length} updates` : ""}</span>
        <span className="activity-state">{status}</span>
      </summary>
      {summaries.length ? (
        <ol className="activity-reasoning-list">
          {summaries.map((summary, index) => <li key={`${index}-${summary}`}>{summary}</li>)}
        </ol>
      ) : <div className="activity-text">Reasoning summary unavailable.</div>}
    </details>
  )
}

function cleanReasoning(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

function AgentInputCard({
  request,
  onSubmit,
}: {
  request: AgentInputRequestInfo
  onSubmit: (answers: Record<string, string[]>) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const complete = request.questions.every((question) => Boolean(answers[question.id]?.trim()))
  return (
    <form
      className="agent-input-card"
      onSubmit={(event) => {
        event.preventDefault()
        if (!complete) return
        onSubmit(Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, [answer]])))
      }}
    >
      <span className="permission-tag">{providerAsksLabel(request.source)}</span>
      {request.questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.header || "Question"}</legend>
          <p>{question.prompt}</p>
          {question.options?.length ? (
            <div className="agent-input-options">
              {question.options.map((option) => (
                <button
                  type="button"
                  key={option.label}
                  className={answers[question.id] === option.label ? "selected" : ""}
                  title={option.description}
                  onClick={() => setAnswers((curr) => ({ ...curr, [question.id]: option.label }))}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <input
            type={question.secret ? "password" : "text"}
            value={answers[question.id] ?? ""}
            placeholder={question.options?.length ? "Or type another answer…" : "Your answer…"}
            onChange={(event) => {
              const value = event.currentTarget.value
              setAnswers((curr) => ({ ...curr, [question.id]: value }))
            }}
          />
        </fieldset>
      ))}
      <button type="submit" className="tb-btn primary" disabled={!complete}>Send answer</button>
    </form>
  )
}

function providerAsksLabel(source: string): string {
  const provider = source.split(":", 1)[0] || "Agent"
  return `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)} asks`
}

export function ChatView({
  session,
  onboard,
  highlightMessageId,
  onHighlightShown,
  usage,
  pendingPermissions,
  onResolvePermission,
  pendingInputRequests,
  onResolveInput,
  messages,
  hasOlderMessages = false,
  loadingOlder = false,
  onLoadOlder,
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
  onOpenDiff,
  dockOpen,
  onToggleDock,
}: Props) {
  const [draft, setDraft] = useState("")
  const [attachments, setAttachments] = useState<MessageAttachment[]>([])
  const [preview, setPreview] = useState<{
    attachments: MessageAttachment[]
    path: string
    returnFocus: HTMLElement | null
  } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)
  const flashedRef = useRef<string | null>(null)
  /** After prepending archive pages, restore viewport over the same content. */
  const scrollRestoreRef = useRef<{ height: number; top: number } | null>(null)
  // Composer state is local for fast typing, but belongs to a session rather
  // than to the currently mounted view. Switching chats must not eat a prompt.
  const draftsBySessionRef = useRef(new Map<string, ComposerDraft>())
  const activeDraftSessionRef = useRef<string | null>(null)
  const draftRef = useRef(draft)
  const attachmentsRef = useRef(attachments)
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
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    const previousId = activeDraftSessionRef.current
    if (previousId) {
      draftsBySessionRef.current.set(previousId, {
        text: draftRef.current,
        attachments: attachmentsRef.current,
      })
    }
    activeDraftSessionRef.current = session?.id ?? null
    const restored = session ? draftsBySessionRef.current.get(session.id) : undefined
    setDraft(restored?.text ?? "")
    setAttachments(restored?.attachments ?? [])
    setPreview(null)
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

  useEffect(() => {
    const pending = scrollRestoreRef.current
    const node = transcriptRef.current
    if (!pending || !node) return
    node.scrollTop = node.scrollHeight - pending.height + pending.top
    scrollRestoreRef.current = null
  }, [messages])

  function onTranscriptScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64
    atBottomRef.current = near
    setAtBottom((curr) => (curr === near ? curr : near))
    // Lazy-load overflow archive when the user scrolls to the top.
    if (
      hasOlderMessages &&
      !loadingOlder &&
      onLoadOlder &&
      el.scrollTop < 48
    ) {
      requestOlderMessages()
    }
  }

  function requestOlderMessages() {
    const node = transcriptRef.current
    if (node) {
      scrollRestoreRef.current = {
        height: node.scrollHeight,
        top: node.scrollTop,
      }
    }
    onLoadOlder?.()
  }

  function jumpToLatest() {
    atBottomRef.current = true
    setAtBottom(true)
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }

  async function submit() {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || !session || sending) return
    const selectedAttachments = attachments
    const files = selectedAttachments.map((item) => item.path)
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
      setAttachments(selectedAttachments)
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
        await addAttachmentPaths([path])
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
    await addAttachmentPaths(files)
  }

  async function addAttachmentPaths(paths: string[]) {
    if (paths.length === 0) return
    const inspected = await window.chatHub.inspectAttachments(paths)
    setAttachments((current) => {
      const existing = new Set(current.map((item) => item.path))
      return [...current, ...inspected.filter((item) => !existing.has(item.path))]
    })
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragActive(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((file) => window.chatHub.getPathForDroppedFile(file))
      .filter(Boolean)
    await addAttachmentPaths(paths)
  }

  const effortCapabilities = useMemo(() => {
    const selectedModel = models.find((model) => model.id === session?.model) ?? models[0]
    const supports = session?.provider === "claude" || session?.provider === "codex"
    const available: Effort[] = session?.provider === "codex"
      ? selectedModel?.reasoningEfforts ?? ["low", "medium", "high", "xhigh", "max", "ultra"]
      : ["low", "medium", "high", "max"]
    return { selectedModel, supports, available }
  }, [models, session?.model, session?.provider])

  useEffect(() => {
    if (!session || !effortCapabilities.supports || effortCapabilities.available.includes(effort)) return
    const providerDefault = effortCapabilities.selectedModel?.defaultReasoningEffort
    onEffortChange(
      providerDefault && effortCapabilities.available.includes(providerDefault)
        ? providerDefault
        : effortCapabilities.available[0] ?? "medium",
    )
  }, [effort, effortCapabilities, onEffortChange, session])

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
  const supportsEffort = effortCapabilities.supports
  const availableEfforts = effortCapabilities.available
  const running = session.status === "running"
  const usageLabel = usage ? formatSessionUsage(usage) : null

  return (
    <main className="main">
      <TopBar
        session={session}
        git={git}
        dockOpen={dockOpen}
        onToggleDock={onToggleDock}
        onOpenFolder={onOpenFolder}
        onOpenEditor={onOpenEditor}
        onCommit={onCommit}
        onRename={onRename}
      />

      <div className="system-banner" title={session.cwd}>
        <span className="mono-soft">
          {session.provider}
          {` · ${modelLabel}`}
          {` · ${PERMISSION_LABELS[permissionMode]}`}
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
          Ask mode — risky Codex actions are denied until the approval card is
          answered. YOLO keeps turns moving without prompts.
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

      {pendingInputRequests.map((request) => (
        <AgentInputCard
          key={request.requestId}
          request={request}
          onSubmit={(answers) => onResolveInput(request.requestId, answers)}
        />
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
          <>
          {hasOlderMessages || loadingOlder ? (
            <div className="transcript-load-older">
              {loadingOlder ? (
                <span className="dim">Loading earlier messages…</span>
              ) : (
                <button
                  type="button"
                  className="link-btn"
                  onClick={requestOlderMessages}
                >
                  Load earlier messages
                </button>
              )}
            </div>
          ) : null}
          {messages.map((m) => (
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
                  {m.attachments?.length ? (
                    <AttachmentGallery
                      attachments={m.attachments}
                      className="message-attachments"
                      onOpen={(attachment, trigger) => setPreview({
                        attachments: m.attachments ?? [],
                        path: attachment.path,
                        returnFocus: trigger,
                      })}
                    />
                  ) : null}
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
                  <TurnItems items={m.items} streaming={m.streaming === true} />
                  {m.content.trim() ? (
                    <section className="turn-result">
                      <div className="turn-result-label">
                        {m.streaming ? "Response" : "Result"}
                      </div>
                      <MarkdownBody
                        text={m.content}
                        messageId={m.id}
                        streaming={m.streaming}
                        cwd={session.cwd}
                        onOpenDiff={onOpenDiff}
                      />
                    </section>
                  ) : null}
                </>
              )}
            </article>
          ))}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <div
        className={`composer-dock ${dragActive ? "is-dragging" : ""}`}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files")) setDragActive(true)
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false)
        }}
        onDrop={(event) => void onDrop(event)}
      >
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
          <AttachmentGallery
            attachments={attachments}
            removable
            className="composer-attachments"
            onRemove={(path) => setAttachments((current) => current.filter((item) => item.path !== path))}
            onOpen={(attachment, trigger) => setPreview({
              attachments,
              path: attachment.path,
              returnFocus: trigger,
            })}
          />
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
                title={`${PERMISSION_HINTS[permissionMode]} · applies to this session`}
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
                    ? `Reasoning effort (${session.provider})`
                    : `${session.provider} does not expose an effort control`
                }
              >
                <select
                  value={effort}
                  disabled={!supportsEffort}
                  onChange={(e) => onEffortChange(e.target.value as Effort)}
                  aria-label="Effort"
                >
                  {availableEfforts.map((level) => (
                    <option key={level} value={level}>
                      {{ low: "Light", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" }[level]}
                    </option>
                  ))}
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
        <AttachmentLightbox
          attachments={preview.attachments}
          initialPath={preview.path}
          returnFocus={preview.returnFocus}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </main>
  )
}
