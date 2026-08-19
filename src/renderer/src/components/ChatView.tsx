import {
  useEffect,
  useLayoutEffect,
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
import { PERMISSION_LABELS } from "@shared/permission"
import type { ProjectScript } from "@shared/scripts"
import type { Mode, ModelInfo } from "@shared/settings-types"
import { formatClock, formatRelative } from "../lib/format"
import {
  loadStash,
  pushStash,
  removeStash,
  type StashEntry,
} from "../lib/prompt-stash"
import {
  onPendingComposerInsert,
  takeComposerInsert,
} from "../lib/pending-prompt"
import {
  nextVoicePhase,
  voiceToggleIntent,
  VOICE_WAIT_TIMEOUT_MS,
  type VoiceEvent,
  type VoicePhase,
} from "../lib/voice-state"
import { PlanSteps, toPlanSteps } from "./PlanSteps"
import { ComposerMenu } from "./ComposerMenu"
import { LiveStepTicker } from "./LiveStepTicker"
import { buildTranscript } from "../lib/tool-runs"
import { currentStep, planProgress } from "../lib/live-step"
import { formatSessionUsage, formatUsage, usageDetail } from "../lib/usage"
import {
  contextUsedTokens,
  contextWindowFor,
  formatContextMeter,
} from "@shared/context-window"
import { MarkdownBody } from "./MarkdownBody"
import { TopBar } from "./TopBar"
import { AttachmentGallery } from "./AttachmentGallery"
import { AttachmentLightbox } from "./AttachmentLightbox"
import { GrokTrustBanner } from "./GrokTrustBanner"

type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

/** The auth nag, rendered inline so it never outweighs the session title. */
export type OnboardNotice = {
  text: string
  onOpenSettings: () => void
  onDismiss: () => void
}

type Props = {
  session: SessionMeta | null
  /** All sessions — the stash popover resolves entry origins to titles. */
  sessions: SessionMeta[]
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
  onUnsettle: () => void
  scripts: ProjectScript[]
  onRunScript: (script: ProjectScript) => void
  onSaveScripts: (scripts: ProjectScript[]) => Promise<void>
  /** A path from a turn's changed-files row — opens it in the Diff surface. */
  onOpenDiff: (path: string) => void
  dockOpen: boolean
  onToggleDock: () => void
  /** An overlay owns Escape while open — the dictation cancel must not eat it. */
  anyOverlayOpen: boolean
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

function ContextMeter({
  usage,
  model,
}: {
  usage: SessionUsage | null
  model?: string
}) {
  const last = usage?.lastTurn
  if (!last) return null
  const used = contextUsedTokens(last)
  const window = contextWindowFor(model, last.contextWindow ?? usage.contextWindow)
  if (used === null || window === null) return null
  const { label, ratio } = formatContextMeter(used, window)
  const tone = ratio >= 0.9 ? " is-critical" : ratio >= 0.7 ? " is-warning" : ""
  return (
    <div
      className={`context-meter${tone}`}
      title={`Context after last turn · ${usageDetail(last)}`}
    >
      <span className="context-meter-bar" aria-hidden>
        <span
          className="context-meter-fill"
          style={{ width: `${Math.round(ratio * 1000) / 10}%` }}
        />
      </span>
      <span className="context-meter-label">{label}</span>
    </div>
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
      {activity.length ? (
        <ActivityOverview items={activity} streaming={streaming} />
      ) : streaming ? (
        <LiveActivityPlaceholder />
      ) : null}
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

function LiveActivityPlaceholder({ label = "Preparing the next step" }: { label?: string }) {
  return (
    <div className="activity-live" aria-live="polite">
      <span className="activity-status status-running" aria-label="running" />
      <span className="activity-live-kicker">Working now</span>
      <strong className="activity-live-label">{label}</strong>
      <span className="activity-state">live</span>
    </div>
  )
}

/** A readable outcome before the detailed, chronological tool cards. */
function ActivityOverview({
  items,
  streaming,
}: {
  items: Exclude<AgentTurnItem, { kind: "reasoning" }>[]
  streaming: boolean
}) {
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
      {live ? <LiveActivityPlaceholder label={liveActionLabel(live)} /> : null}
      {streaming && !live ? (
        <LiveActivityPlaceholder label="Preparing the next step after the last action" />
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

function stashPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

function providerAsksLabel(source: string): string {
  const provider = source.split(":", 1)[0] || "Agent"
  return `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)} asks`
}

export function ChatView({
  session,
  sessions,
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
  onUnsettle,
  scripts,
  onRunScript,
  onSaveScripts,
  onOpenDiff,
  dockOpen,
  onToggleDock,
  anyOverlayOpen,
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
  // Dictation via Handy. The button only exists when Handy is installed.
  const [voiceAvailable, setVoiceAvailable] = useState(false)
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle")
  // True while a voiceToggle IPC is in flight — clicks in that window would
  // re-read the not-yet-updated phase and send Handy a second toggle.
  const voiceBusyRef = useRef(false)
  const [confirmRevertId, setConfirmRevertId] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)
  const [revertError, setRevertError] = useState<string | null>(null)
  const [stash, setStash] = useState<StashEntry[]>(() => loadStash())
  const [stashOpen, setStashOpen] = useState(false)
  const [stashedFlash, setStashedFlash] = useState(false)
  const stashRef = useRef<HTMLDivElement | null>(null)
  const stashFlashTimer = useRef<number | undefined>(undefined)

  // Oldest→newest list of what you actually sent this session — the shell-style
  // ↑/↓ recall reads from it so you can re-run a prompt without retyping.
  const promptHistory = useMemo(
    () => messages.filter((m) => m.role === "user").map((m) => m.content),
    [messages],
  )

  const sessionTitles = useMemo(
    () => new Map(sessions.map((s) => [s.id, s.title])),
    [sessions],
  )

  useEffect(() => {
    if (!stashOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (!stashRef.current?.contains(e.target as Node)) setStashOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [stashOpen])

  useEffect(() => () => window.clearTimeout(stashFlashTimer.current), [])

  const lastMessage = messages[messages.length - 1]
  const liveMessage =
    session?.status === "running" &&
    lastMessage?.role === "assistant" &&
    lastMessage.streaming === true
      ? lastMessage
      : null
  const liveTicker = useMemo(() => {
    if (!liveMessage) return null
    const { blocks } = buildTranscript(liveMessage.content, liveMessage.id)
    return { step: currentStep(blocks), plan: planProgress(blocks) }
  }, [liveMessage])

  const revertBlocked = sending || session?.status === "running"

  const revertCheckpoint = async (message: ChatMessage) => {
    if (!session || !message.checkpointRef || reverting) return
    setReverting(true)
    setRevertError(null)
    try {
      await window.chatHub.checkpointRevert(session.id, message.checkpointRef)
      setConfirmRevertId(null)
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : String(err))
    } finally {
      setReverting(false)
    }
  }

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
    setConfirmRevertId(null)
    setRevertError(null)
    atBottomRef.current = true
    setAtBottom(true)
  }, [session?.id])

  useEffect(() => {
    const sessionId = session?.id
    if (!sessionId) return
    const consume = (forSessionId: string) => {
      if (forSessionId !== sessionId) return
      const text = takeComposerInsert(sessionId)
      if (text === null) return
      setDraft((prev) => {
        const kept = prev.replace(/\s+$/, "")
        return kept === "" ? text : `${kept}\n\n${text}`
      })
      setHistIndex(-1)
      taRef.current?.focus()
    }
    consume(sessionId)
    return onPendingComposerInsert(consume)
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
    // A pending jump lands in the same commit that delivers the messages it was
    // waiting for, and this effect runs first — following the tail here would
    // scroll past the hit before the jump below ever sees it.
    if (highlightMessageId && flashedRef.current !== highlightMessageId) return
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [messages, session?.id, highlightMessageId])

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
    // A smooth scroll across a freshly loaded archive never arrives: the browser
    // drops the animation while those pages settle their layout. Glide for a hop
    // inside the scrollback, jump outright when the hit is a transcript away.
    const node = transcriptRef.current
    const away = node
      ? Math.abs(el.getBoundingClientRect().top - node.getBoundingClientRect().top)
      : 0
    el.scrollIntoView({
      behavior: node && away > node.clientHeight * 3 ? "auto" : "smooth",
      block: "center",
    })
    el.classList.add("hit-flash")
    const timer = window.setTimeout(() => {
      el.classList.remove("hit-flash")
      onHighlightShown()
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [highlightMessageId, messages, onHighlightShown])

  // Before paint, or the prepended page is visible at the old scrollTop for a
  // frame and the transcript jumps under the reader.
  useLayoutEffect(() => {
    const pending = scrollRestoreRef.current
    if (!pending || loadingOlder) return
    scrollRestoreRef.current = null
    const node = transcriptRef.current
    if (!node || node.scrollHeight === pending.height) return
    node.scrollTop = node.scrollHeight - pending.height + pending.top
  }, [messages, loadingOlder])

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

  function jumpToLiveCard() {
    if (!liveMessage) return
    const card = transcriptRef.current?.querySelector(
      `[data-mid="${CSS.escape(liveMessage.id)}"]`,
    )
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" })
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

  function stashDraft() {
    if (!session || !draft.trim()) return
    setStash(pushStash(draft, session.id))
    setDraft("")
    setHistIndex(-1)
    setStashedFlash(true)
    window.clearTimeout(stashFlashTimer.current)
    stashFlashTimer.current = window.setTimeout(
      () => setStashedFlash(false),
      1200,
    )
  }

  function restoreStash(entry: StashEntry) {
    setStash(removeStash(entry.id))
    setDraft((current) =>
      current.trim() ? `${current.trimEnd()}\n\n${entry.text}` : entry.text,
    )
    setHistIndex(-1)
    setStashOpen(false)
    taRef.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault()
      stashDraft()
      return
    }
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

  function dispatchVoice(event: VoiceEvent) {
    setVoicePhase((phase) => nextVoicePhase(phase, event))
  }

  // Cheap existence probe, refreshed on window focus so installing (or
  // trashing) Handy shows up without a restart.
  useEffect(() => {
    let alive = true
    const probe = () => {
      void window.chatHub
        .voiceAvailable()
        .then((installed) => {
          if (alive) setVoiceAvailable(installed)
        })
        .catch(() => undefined)
    }
    probe()
    window.addEventListener("focus", probe)
    return () => {
      alive = false
      window.removeEventListener("focus", probe)
    }
  }, [])

  async function voiceClick() {
    const intent = voiceToggleIntent(voicePhase)
    if (intent === null) return
    // One toggle per flight: a second click before the IPC resolves would read
    // this same stale phase and double-toggle Handy out from under the button.
    if (voiceBusyRef.current) return
    voiceBusyRef.current = true
    // Handy pastes into whatever field has focus, and the click just moved
    // focus onto this button — on the stop path too. Make it the composer.
    taRef.current?.focus()
    const wanted: VoiceEvent =
      intent === "start"
        ? { type: "toggle-accepted" }
        : { type: "stop-requested" }
    try {
      const ok = await window.chatHub.voiceToggle(intent)
      dispatchVoice(ok ? wanted : { type: "toggle-failed" })
    } catch {
      dispatchVoice({ type: "toggle-failed" })
    } finally {
      voiceBusyRef.current = false
    }
  }

  // Esc aborts a recording. Attached only while recording, on capture, so the
  // app's own Escape (stop the agent's turn) keeps working the rest of the
  // time. Overlays own their own Escape (App.tsx follows the same rule):
  // while one is open the first Esc closes it and the recording survives.
  useEffect(() => {
    if (voicePhase !== "recording" || anyOverlayOpen) return
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      void window.chatHub.voiceCancel().catch(() => undefined)
      dispatchVoice({ type: "cancelled" })
    }
    window.addEventListener("keydown", onEsc, true)
    return () => window.removeEventListener("keydown", onEsc, true)
  }, [voicePhase, anyOverlayOpen])

  // A transcription that never lands (Handy died, focus stolen) must not leave
  // the button spinning; likewise blur — the paste follows focus, not us.
  useEffect(() => {
    if (voicePhase !== "waiting") return
    const timer = window.setTimeout(
      () => dispatchVoice({ type: "timed-out" }),
      VOICE_WAIT_TIMEOUT_MS,
    )
    const onBlur = () => dispatchVoice({ type: "window-blurred" })
    window.addEventListener("blur", onBlur)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("blur", onBlur)
    }
  }, [voicePhase])

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
        scripts={scripts}
        onRunScript={onRunScript}
        onSaveScripts={onSaveScripts}
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

      <GrokTrustBanner cwd={session.cwd} provider={session.provider} />

      {session.settledAt !== undefined ? (
        <div className="settled-banner">
          <span className="settled-banner-text">
            This thread is settled — sending a message reactivates it
          </span>
          <button type="button" className="tb-btn" onClick={onUnsettle}>
            Un-settle
          </button>
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
                    {m.checkpointRef && confirmRevertId !== m.id ? (
                      <button
                        type="button"
                        className="checkpoint-btn"
                        title={
                          revertBlocked
                            ? "Stop the running turn before reverting"
                            : "Revert files and transcript to before this message"
                        }
                        disabled={revertBlocked}
                        onClick={() => {
                          setRevertError(null)
                          setConfirmRevertId(m.id)
                        }}
                      >
                        ⟲
                      </button>
                    ) : null}
                  </div>
                  {confirmRevertId === m.id ? (
                    <div className="checkpoint-confirm">
                      <span className="checkpoint-confirm-text">
                        Revert files + transcript to before this message? The
                        CLI still remembers the reverted turns.
                      </span>
                      {revertError ? (
                        <span className="checkpoint-error">{revertError}</span>
                      ) : null}
                      <div className="checkpoint-confirm-actions">
                        <button
                          type="button"
                          className="tb-btn"
                          disabled={reverting}
                          onClick={() => {
                            setConfirmRevertId(null)
                            setRevertError(null)
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="tb-btn primary"
                          disabled={reverting || revertBlocked}
                          onClick={() => void revertCheckpoint(m)}
                        >
                          {reverting ? "Reverting…" : "Revert"}
                        </button>
                      </div>
                    </div>
                  ) : null}
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
        {liveTicker ? (
          <LiveStepTicker
            step={liveTicker.step}
            plan={liveTicker.plan}
            onJump={jumpToLiveCard}
          />
        ) : null}
        <ContextMeter usage={usage} model={session.model} />
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
              // Both of Handy's delivery modes end here — ctrl_v as a paste,
              // direct typing as plain input — and both go through setDraft,
              // so the transcription behaves exactly like typed text.
              if (voicePhase === "waiting") dispatchVoice({ type: "text-arrived" })
              setDraft(e.target.value)
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              if (voicePhase === "waiting") dispatchVoice({ type: "text-arrived" })
              void onPaste(e)
            }}
          />
          {stashedFlash ? (
            <span className="stash-flash" aria-live="polite">
              Stashed
            </span>
          ) : null}
          <div className="composer-toolbar">
            <div className="composer-chips">
              <ComposerMenu
                providerLabel={
                  providers.find((p) => p.id === session.provider)?.label ??
                  session.provider
                }
                model={session.model}
                models={models}
                modeId={session.modeId}
                modes={modes}
                permissionMode={permissionMode}
                effort={effort}
                availableEfforts={availableEfforts}
                supportsEffort={supportsEffort}
                onModelChange={onModelChange}
                onApplyMode={onApplyMode}
                onPermissionChange={onPermissionChange}
                onEffortChange={onEffortChange}
              />
            </div>
            {/* Chips above are session state; everything here performs an
                action, so they do not share a weight. */}
            <div className="composer-actions">
              {voiceAvailable ? (
                <button
                  type="button"
                  className={`composer-action voice-btn is-${voicePhase}`}
                  aria-pressed={voicePhase === "recording"}
                  title={
                    voicePhase === "recording"
                      ? "Stop — Handy transcribes and pastes into the composer (Esc cancels)"
                      : voicePhase === "waiting"
                        ? "Waiting for Handy's transcription…"
                        : "Dictate with Handy — keep this window focused so the text lands in the composer"
                  }
                  onClick={() => void voiceClick()}
                >
                  <span aria-hidden>
                    {voicePhase === "recording" ? "●" : "◉"}
                  </span>{" "}
                  {voicePhase === "recording"
                    ? "Rec"
                    : voicePhase === "waiting"
                      ? "…"
                      : "Voice"}
                </button>
              ) : null}
              <div className="stash-anchor" ref={stashRef}>
                <button
                  type="button"
                  className="composer-action stash-btn"
                  aria-expanded={stashOpen}
                  aria-haspopup="menu"
                  title="Stashed drafts — ⌘S stashes the current draft"
                  onClick={() => {
                    setStash(loadStash())
                    setStashOpen((v) => !v)
                  }}
                >
                  <svg aria-hidden width="9" height="11" viewBox="0 0 9 11">
                    <path
                      d="M1.5 1.5h6v8L4.5 7.1 1.5 9.5z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                  </svg>{" "}
                  Stash
                  {stash.length > 0 ? (
                    <span className="stash-count">{stash.length}</span>
                  ) : null}
                </button>
                {stashOpen ? (
                  <div
                    className="stash-popover"
                    role="menu"
                    onKeyDown={(e) => {
                      if (e.key !== "Escape") return
                      e.stopPropagation()
                      setStashOpen(false)
                    }}
                  >
                    {stash.length === 0 ? (
                      <div className="stash-empty">
                        ⌘S stashes the current draft
                      </div>
                    ) : (
                      stash.map((entry) => {
                        const from = sessionTitles.get(entry.sessionId)
                        return (
                          <div key={entry.id} className="stash-row">
                            <button
                              type="button"
                              className="stash-restore"
                              role="menuitem"
                              title="Append to the current draft"
                              onClick={() => restoreStash(entry)}
                            >
                              <span className="stash-text">
                                {stashPreview(entry.text)}
                              </span>
                              <span className="stash-meta">
                                {formatRelative(entry.at)}
                                {from ? ` · ${from}` : ""}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="stash-delete"
                              aria-label="Delete stashed draft"
                              title="Delete"
                              onClick={() => setStash(removeStash(entry.id))}
                            >
                              ✕
                            </button>
                          </div>
                        )
                      })
                    )}
                  </div>
                ) : null}
              </div>
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
