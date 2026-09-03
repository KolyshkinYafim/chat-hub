import { randomUUID } from "node:crypto"
import type {
  ChatMessage,
  CreateSessionInput,
  ProviderId,
  ProviderRateLimits,
  QueuedMessage,
  SessionMeta,
  SessionSnapshot,
  SessionStatus,
  SessionUsage,
  TurnUsage,
} from "@shared/types"
import { normalizeProject } from "@shared/project"
import { getAdapter } from "./adapters"
import { resolveBinaryForSpawn } from "./provider-probe"
import type {
  AdapterCallbacks,
  ConversationTurn,
  EffortLevel,
} from "./adapters/types"
import type { EventBus } from "./event-bus"
import type { SessionMonitorBridge } from "./bridge"
import type { NotificationService } from "./notifications"
import type { Persistence, PersistedIndex } from "./persistence"
import { buildDemoState } from "./demo-seed"
import { addUsage } from "./adapters/usage"
import type { PermissionBroker } from "./permission-broker"
import type { UsageLedger } from "./usage-ledger"
import { realpathSync, statSync } from "node:fs"
import type { PermissionMode } from "@shared/permission"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import type { SettingsStore } from "./settings"
import { HookRunner } from "./hooks"
import { inspectAttachmentPaths } from "./attachments"
import { MessageArchive, type ArchivedContext } from "./message-archive"
import {
  MIN_TRANSCRIPT_QUERY,
  mergeTranscriptHits,
  searchTranscripts,
  type ArchiveSearchResult,
  type TranscriptHit,
} from "@shared/search"
import { createSessionWorktree, removeSessionWorktree } from "./git"
import { heuristicTitle, looksDefaultTitle } from "@shared/title"
import { generateTitle } from "./title-llm"
import { listUnignoredMcpNativeFiles } from "./mcp"
import {
  createCheckpoint,
  deleteSessionCheckpoints,
  pruneCheckpoints,
  revertToCheckpoint,
} from "./checkpoints"

/** Retention window: how many per-turn checkpoints a session keeps. */
export const MAX_CHECKPOINTS_PER_SESSION = 20

/**
 * How long a turn waits for its own snapshot before it stops waiting. Ordering
 * the snapshot ahead of the agent is what makes a checkpoint mean "before this
 * turn"; the cap keeps a repo too large to hash in time from delaying the send.
 */
export const CHECKPOINT_GATE_MS = 2500

const ARCHIVE_REFILL_LIMIT = 50
import { runWorktreeCreateScripts } from "./surfaces/scripts"
import { projectContextBrief } from "./surfaces/project-context"
import { applyPlanToBoard } from "./surfaces/board"

/** Live window size; older turns spill into MessageArchive, not the void. */
export const MAX_MESSAGES_PER_SESSION = 200

export type SendOpts = {
  effort?: EffortLevel
  attachments?: string[]
}

export type BrowserMcpTarget = {
  id: string
  provider: string
  cwd: string
}

export type BrowserMcpRegistrar = (session: BrowserMcpTarget) => Promise<unknown>

/** Watchdog cadence and how long a turn may stay silent before we call it dead. */
export type WatchdogConfig = { intervalMs: number; silenceMs: number }

const WATCHDOG: WatchdogConfig = {
  intervalMs: 15_000,
  // Generous on purpose: a legitimate tool call (test suite, install) goes quiet
  // for minutes, and killing a live agent is worse than a late status.
  silenceMs: 10 * 60_000,
}

/** Queue entry: the shared QueuedMessage the UI renders plus its send opts. */
type QueuedTurn = {
  id: string
  content: string
  createdAt: number
  opts?: SendOpts
  userMessageId?: string
}

export type TitleGenerator = (
  userMessage: string,
  assistantExcerpt: string,
) => Promise<string | null>

/** Runs a fresh worktree's setup scripts; returns transcript notice lines. */
export type WorktreeSetupRunner = (
  baseCwd: string,
  worktreeCwd: string,
) => Promise<string[]>

export class SessionManager {
  private sessions = new Map<string, SessionMeta>()
  /** Debounce TodoWrite → board.json so a streaming checklist doesn't hammer disk. */
  private planBoardTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private messages = new Map<string, ChatMessage[]>()
  private hotLoaded = new Set<string>()
  private hotLoads = new Map<string, Promise<void>>()
  private hotWrites = new Map<string, Promise<void>>()
  private dirtyIndex = false
  private dirtySessions = new Set<string>()
  private activeSessionId: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  /** In-flight turns: presence means a live adapter process belongs to the id. */
  private turns = new Map<string, { lastActivityAt: number; token: number }>()
  private nextTurnToken = 1
  private queued = new Map<string, QueuedTurn[]>()
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private usage = new Map<string, SessionUsage>()
  /** Last allowance reading per session. Live only — a restart refetches it. */
  private rateLimits = new Map<string, ProviderRateLimits>()
  private permissions: PermissionBroker | null = null
  private registerBrowserMcp: BrowserMcpRegistrar | null = null
  private browserToolsReady = new Set<string>()
  private readonly hooks: HookRunner
  private readonly archive: MessageArchive
  /** Live-window cap; overridable in tests so overflow is cheap to exercise. */
  private readonly maxMessages: number
  /** Sessions that have spilled into archive.jsonl (or already had one on disk). */
  private archivedSessions = new Set<string>()
  private adapterRestores = new Map<string, Promise<void>>()
  /** Preserve archive order and let an immediate scroll-back wait for its write. */
  private archiveWrites = new Map<string, Promise<void>>()
  private inputStatusWired = false
  /** Sessions already told their workspace carries an unignored CLI config. */
  private configNoted = new Set<string>()
  private readonly generateTitleFn: TitleGenerator
  private readonly usageLedger: UsageLedger | null
  private readonly worktreeSetup: WorktreeSetupRunner

  constructor(
    private readonly bus: EventBus,
    private readonly persistence: Persistence,
    private readonly bridge: SessionMonitorBridge,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsStore,
    private readonly watchdog: WatchdogConfig = WATCHDOG,
    opts?: {
      archive?: MessageArchive
      maxMessages?: number
      titleGenerator?: TitleGenerator
      worktreeSetup?: WorktreeSetupRunner
      usageLedger?: UsageLedger
    },
  ) {
    // Prompt hooks re-enter sendMessage so they share the normal queue (never
    // touch SessionMeta). Fire-and-forget from the runner; turn_done hooks that
    // enqueue must not re-fire themselves in a tight loop — sendMessage only
    // dispatches when no turn is live, so a turn_done prompt waits for idle.
    this.hooks = new HookRunner(this.bus, (sessionId, text) => {
      void this.sendMessage(sessionId, text)
    })
    this.archive =
      opts?.archive ?? MessageArchive.fromStatePath(this.persistence.filePath)
    this.maxMessages = opts?.maxMessages ?? MAX_MESSAGES_PER_SESSION
    this.generateTitleFn =
      opts?.titleGenerator ?? ((user, assistant) => generateTitle(user, assistant))
    this.worktreeSetup = opts?.worktreeSetup ?? runWorktreeCreateScripts
    this.usageLedger = opts?.usageLedger ?? null
  }

  /**
   * Writes the built-in browser MCP server into the session's project config.
   * A CLI reads that config at process start, so this must be awaited before
   * the CLI process it should reach spawns, and a failure must never block the
   * spawn. Once per session per run — at creation, then lazily on the first
   * send — never from the boot-time restore, which would rewrite CLI configs
   * across every restored workspace on every launch.
   */
  setBrowserMcpRegistrar(register: BrowserMcpRegistrar): void {
    this.registerBrowserMcp = register
  }

  private async prepareBrowserTools(session: BrowserMcpTarget): Promise<void> {
    if (!this.registerBrowserMcp) return
    if (this.browserToolsReady.has(session.id)) return
    this.browserToolsReady.add(session.id)
    try {
      await this.registerBrowserMcp(session)
    } catch (err) {
      this.browserToolsReady.delete(session.id)
      console.warn("[session-manager] browser mcp registration failed", err)
    }
  }

  /**
   * Registering the browser tools writes a CLI config into the workspace, and
   * that file holds this machine's absolute paths — worth one line in the
   * thread so it is not discovered as a stray entry in someone's next commit.
   * Said once, when the session is born: restoring an old session re-registers
   * the same file, and repeating the notice on every launch would be noise.
   */
  private async noteUnignoredConfigs(
    sessionId: string,
    cwd: string,
  ): Promise<void> {
    if (this.configNoted.has(sessionId)) return
    this.configNoted.add(sessionId)
    const unignored = await listUnignoredMcpNativeFiles(cwd).catch(() => [])
    if (unignored.length === 0) return
    const them = unignored.length === 1 ? "it" : "them"
    this.note(
      sessionId,
      `Wrote ${unignored.join(", ")} here so the CLI can see the Hub's tools. Git does not ignore ${them} — Settings › MCP can add ${them} to .gitignore.`,
    )
  }

  /**
   * The broker is built after the manager (it needs a session lookup that only
   * exists once the manager does), so it arrives by setter rather than by ctor.
   * Wire waiting_input from Ask-mode pendingInputs here once.
   */
  setPermissionBroker(broker: PermissionBroker): void {
    this.permissions = broker
    if (this.inputStatusWired) return
    this.inputStatusWired = true
    this.bus.on((event) => {
      if (event.type === "input.request") {
        const sid = event.request.sessionId
        if (sid) this.syncWaitingInputStatus(sid)
        return
      }
      if (event.type === "input.resolved") {
        const sid = event.sessionId
        if (sid) this.syncWaitingInputStatus(sid)
      }
    })
  }

  /** True when this session has spilled messages into the on-disk archive. */
  hasArchivedMessages(sessionId: string): boolean {
    return this.archivedSessions.has(sessionId)
  }

  /**
   * Load older messages from the overflow archive (oldest→newest page).
   * `beforeMessageId` is the currently oldest loaded message (or null for the
   * first page under the live window).
   */
  async loadArchivedMessages(
    sessionId: string,
    beforeMessageId: string | null,
    limit = 50,
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean; hasArchive: boolean }> {
    await this.archiveWrites.get(sessionId)
    const hasArchive = await this.archive.hasArchive(sessionId)
    if (hasArchive) this.archivedSessions.add(sessionId)
    if (!hasArchive) {
      return { messages: [], hasMore: false, hasArchive: false }
    }
    const page = await this.archive.loadBefore(sessionId, beforeMessageId, limit)
    return { ...page, hasArchive: true }
  }

  /**
   * One contiguous archive page reaching back to `targetMessageId`, for opening
   * a search hit that the renderer has never loaded.
   */
  async loadArchiveThrough(
    sessionId: string,
    beforeMessageId: string | null,
    targetMessageId: string,
  ): Promise<ArchivedContext> {
    await this.archiveWrites.get(sessionId)
    return this.archive.loadThrough(sessionId, beforeMessageId, targetMessageId)
  }

  /**
   * Full-text search over the archived halves of every session's transcript.
   * `loadedFrom` maps a session to the oldest message the renderer is holding,
   * so each side searches only what the other cannot see.
   */
  async searchArchivedTranscripts(
    query: string,
    loadedFrom: Record<string, string | null>,
  ): Promise<ArchiveSearchResult> {
    const q = query.trim()
    if (q.length < MIN_TRANSCRIPT_QUERY) return { hits: [], truncated: false }

    await this.ensureMessagesLoaded().catch(() => undefined)
    const unheld: Record<string, ChatMessage[]> = {}
    for (const sessionId of this.sessions.keys()) {
      if (Object.hasOwn(loadedFrom, sessionId)) continue
      unheld[sessionId] = this.getMessages(sessionId)
    }
    const live = searchTranscripts(q, unheld)

    const archived: TranscriptHit[] = []
    let truncated = false
    for (const sessionId of this.archivedSessions) {
      if (!this.sessions.has(sessionId)) continue
      const found = await this.archive.search(
        sessionId,
        q,
        loadedFrom[sessionId] ?? null,
      )
      if (found.truncated) truncated = true
      if (found.hit) archived.push(found.hit)
    }
    return {
      hits: [...mergeTranscriptHits(live, archived).values()],
      truncated,
    }
  }

  /**
   * Map a hook's agent-side id back onto a Hub session. Hooks namespace the id
   * ("claude-<uuid>"); we persist the bare CLI id, hence the prefix tolerance.
   * The cwd fallback catches the first permission of a turn, which can arrive
   * before the CLI has told us its session id at all.
   */
  findSessionForAgent(agentSessionId: string, cwd?: string): string | null {
    const bare = agentSessionId.replace(/^(claude|codex|grok|opencode)-/, "")
    for (const s of this.sessions.values()) {
      if (!s.agentSessionId) continue
      if (s.agentSessionId === agentSessionId || s.agentSessionId === bare) {
        return s.id
      }
    }
    if (!cwd) return null
    const live = this.listSessions().filter(
      (s) => s.cwd === cwd && this.turns.has(s.id),
    )
    return live[0]?.id ?? null
  }

  getPermissionMode(): PermissionMode {
    return this.settings.permissionMode
  }

  /** The global default, used by every session that has not overridden it. */
  async setPermissionMode(mode: PermissionMode): Promise<PermissionMode> {
    const next = await this.settings.setPermissionMode(mode)
    return next.permissionMode
  }

  /** What this session's next turn will actually run with. */
  permissionModeFor(session: SessionMeta): PermissionMode {
    return (
      session.permissionMode ??
      this.settings.permissionMode ??
      DEFAULT_PERMISSION_MODE
    )
  }

  /**
   * Override the mode for one session. `undefined` clears the override, so the
   * session goes back to following the global default rather than freezing
   * whatever the default happened to be at the time.
   */
  setSessionPermissionMode(
    sessionId: string,
    mode: PermissionMode | undefined,
  ): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    const next: SessionMeta = { ...session, permissionMode: mode, updatedAt: Date.now() }
    this.sessions.set(sessionId, next)
    this.publishSessionEvent({ type: "session.upsert", session: next })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
    return next
  }

  setSessionModel(sessionId: string, model: string): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    const next = {
      ...session,
      model: model.trim() || undefined,
      updatedAt: Date.now(),
    }
    this.sessions.set(sessionId, next)
    this.publishSessionEvent({ type: "session.upsert", session: next })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
    return next
  }

  /**
   * Attach (or clear) a mode preset. `modeId`/`systemPrompt` are always set —
   * passing them undefined clears the mode — while model/permission only change
   * when the mode actually specifies them, so "No mode" never resets those.
   */
  applySessionMode(
    sessionId: string,
    patch: {
      modeId?: string
      systemPrompt?: string
      model?: string
      permissionMode?: PermissionMode
    },
  ): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    const next: SessionMeta = {
      ...session,
      modeId: patch.modeId,
      systemPrompt: patch.systemPrompt?.trim() || undefined,
      updatedAt: Date.now(),
    }
    if (patch.model !== undefined) next.model = patch.model.trim() || undefined
    if (patch.permissionMode !== undefined) {
      next.permissionMode = patch.permissionMode
    }
    this.sessions.set(sessionId, next)
    this.publishSessionEvent({ type: "session.upsert", session: next })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
    return next
  }

  /**
   * Settling is a decision, never a side effect: only this call and archiving
   * put a thread away, so the sidebar keeps showing work until its owner says
   * otherwise. Sending into a settled thread brings it back (see `unsettle`).
   */
  setSessionSettled(sessionId: string, settled: boolean): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    const next: SessionMeta = { ...session, updatedAt: Date.now() }
    if (settled) {
      next.settledAt = Date.now()
      next.settledBy = "user"
    } else {
      delete next.settledAt
      delete next.settledBy
    }
    this.sessions.set(sessionId, next)
    this.publishSessionEvent({ type: "session.upsert", session: next })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
    return next
  }

  /**
   * Favouriting is orthogonal to settling: a favourite is pinned to the top of
   * the sidebar and stays there once its thread is put away, which is the whole
   * reason to favourite one.
   */
  setSessionFavorite(sessionId: string, favorite: boolean): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    const next: SessionMeta = { ...session, updatedAt: Date.now() }
    if (favorite) {
      next.favorite = true
    } else {
      delete next.favorite
    }
    this.sessions.set(sessionId, next)
    this.publishSessionEvent({ type: "session.upsert", session: next })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
    return next
  }

  /** Archiving implies settled; unarchiving does not unsettle. */
  setSessionArchived(sessionId: string, archived: boolean): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    const next: SessionMeta = { ...session, updatedAt: Date.now() }
    if (archived) {
      next.archived = true
      if (next.settledAt === undefined) {
        next.settledAt = Date.now()
        next.settledBy = "user"
      }
    } else {
      delete next.archived
    }
    this.sessions.set(sessionId, next)
    this.publishSessionEvent({ type: "session.upsert", session: next })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
    return next
  }

  /** One-shot import of the renderer's legacy localStorage archive ids. */
  migrateArchived(ids: string[]): void {
    let changed = false
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (!session || session.archived) continue
      const next: SessionMeta = { ...session, archived: true }
      if (next.settledAt === undefined) {
        next.settledAt = Date.now()
        next.settledBy = "user"
      }
      this.sessions.set(id, next)
      this.publishSessionEvent({ type: "session.upsert", session: next })
      changed = true
    }
    if (!changed) return
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
  }

  /**
   * A turn that was stopped or superseded loses ownership the moment its
   * registration is replaced, so its late resolution must touch nothing — the
   * CLIs let a resend proceed while the killed process is still dying.
   */
  private ownsTurn(sessionId: string, token: number): boolean {
    return this.turns.get(sessionId)?.token === token
  }

  private unsettle(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.settledAt === undefined) return
    const next: SessionMeta = { ...session, updatedAt: Date.now() }
    delete next.settledAt
    delete next.settledBy
    this.sessions.set(sessionId, next)
    this.publishSessionEvent({ type: "session.upsert", session: next })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
  }

  /** A rename the user typed; from here on auto-titling keeps its hands off. */
  renameSession(sessionId: string, title: string): SessionMeta {
    const t = title.trim()
    if (!t) throw new Error("Title required")
    return this.applyTitle(sessionId, t, "user")
  }

  /**
   * User-forced LLM pass. Allowed for any session — including a hand-renamed
   * one — but the result is an "auto" title again, so later renames stay sacred.
   */
  async regenerateTitle(sessionId: string): Promise<SessionMeta> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    await this.loadHot(sessionId).catch(() => undefined)
    const exchange = this.firstExchange(sessionId)
    if (!exchange) return session
    this.markTitleRefined(sessionId)
    const title = await this.generateTitleFn(exchange.user, exchange.assistant)
    const current = this.sessions.get(sessionId)
    if (!current) throw new Error("Session not found")
    // A rename typed while the model was thinking wins: the user renamed the
    // title they could see, which is newer than the one they asked for.
    if (!title || current.title !== session.title) return current
    return this.applyTitle(sessionId, title, "auto")
  }

  /**
   * Burn the session's one automatic title pass. Written into the meta rather
   * than a runtime set so it survives a restart, and silent because no view
   * renders it.
   */
  private markTitleRefined(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.titleRefined) return
    this.sessions.set(sessionId, { ...session, titleRefined: true })
    this.scheduleSave()
  }

  private applyTitle(
    sessionId: string,
    title: string,
    titleOrigin: "auto" | "user",
  ): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    const next: SessionMeta = {
      ...session,
      title,
      titleOrigin,
      updatedAt: Date.now(),
    }
    this.sessions.set(sessionId, next)
    this.publishSessionEvent({ type: "session.upsert", session: next })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
    return next
  }

  private titleOriginOf(session: SessionMeta): "default" | "auto" | "user" {
    return (
      session.titleOrigin ??
      (looksDefaultTitle(session.title) ? "default" : "user")
    )
  }

  private maybeAutoTitle(sessionId: string, content: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (this.titleOriginOf(session) !== "default") return
    const userMessages = (this.messages.get(sessionId) ?? []).filter(
      (m) => m.role === "user",
    )
    if (userMessages.length !== 1) return
    const title = heuristicTitle(content)
    if (!title) return
    this.applyTitle(sessionId, title, "auto")
  }

  private maybeRefineTitle(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.titleRefined) return
    if (this.titleOriginOf(session) === "user") return
    const exchange = this.firstExchange(sessionId)
    if (!exchange) return
    this.markTitleRefined(sessionId)
    void this.generateTitleFn(exchange.user, exchange.assistant)
      .then((title) => {
        if (!title) return
        const current = this.sessions.get(sessionId)
        if (!current || this.titleOriginOf(current) === "user") return
        this.applyTitle(sessionId, title, "auto")
      })
      .catch(() => undefined)
  }

  private firstExchange(
    sessionId: string,
  ): { user: string; assistant: string } | null {
    const list = this.messages.get(sessionId) ?? []
    const userIdx = list.findIndex((m) => m.role === "user")
    if (userIdx === -1) return null
    const assistant = list
      .slice(userIdx + 1)
      .find((m) => m.role === "assistant")
    return { user: list[userIdx].content, assistant: assistant?.content ?? "" }
  }

  async init(): Promise<void> {
    if (this.started) return
    this.started = true

    let index = await this.persistence.loadIndex()
    // Demo seed only when explicitly requested (not for daily driver).
    if (index.sessions.length === 0 && process.env.CHAT_HUB_DEMO === "1") {
      const demo = buildDemoState()
      index = {
        version: 1,
        sessions: demo.sessions,
        usage: {},
        activeSessionId: demo.activeSessionId,
      }
      for (const [id, msgs] of Object.entries(demo.messages)) {
        await this.persistence.saveHotMessages(id, msgs)
      }
      await this.persistence.saveIndex(index)
    }

    for (const session of index.sessions) {
      // Drop demo / missing project paths — only real folders survive restart.
      const cwd = session.cwd || ""
      if (!cwdLooksReal(cwd)) {
        continue
      }
      // Never restore as stuck running without a live process, and never as a
      // finished turn nobody watched end: a restart is not fresh agent output.
      const status: SessionStatus =
        session.status === "running" || session.status === "done"
          ? "idle"
          : session.status
      const restored: SessionMeta = {
        ...session,
        cwd,
        project: session.project || normalizeProject(undefined, cwd),
        status,
        activityAt: session.activityAt ?? session.updatedAt,
      }
      // Threads the Hub used to settle by itself come back: settling is the
      // owner's call now, and leaving those stamps would keep a sidebar full
      // of finished-looking work that nobody chose to put away.
      if (restored.settledBy === "auto") {
        delete restored.settledAt
        delete restored.settledBy
      }
      this.sessions.set(session.id, restored)
    }
    for (const [id, total] of Object.entries(index.usage ?? {})) {
      if (this.sessions.has(id)) this.usage.set(id, total)
    }
    this.activeSessionId = index.activeSessionId
    if (
      this.activeSessionId &&
      !this.sessions.has(this.activeSessionId)
    ) {
      this.activeSessionId = null
    }

    // Publish corrected post-restart state so Monitor does not keep stale "running".
    for (const session of this.listSessions()) {
      this.publishSessionEvent({ type: "session.upsert", session })
    }

    this.bus.emit({
      type: "sessions.replaced",
      sessions: this.listSessions(),
    })

    for (const session of this.listSessions()) {
      if (await this.archive.hasArchive(session.id)) {
        this.archivedSessions.add(session.id)
      }
    }

    // Re-register restored sessions with their adapter so follow-up turns work
    // after a restart (otherwise send() throws "Session not started"), seeding
    // the persisted CLI session id for resume. One promise per session, so a
    // send only ever waits for its own session's restore.
    for (const session of this.listSessions()) {
      const restore = this.restoreAdapter(session).catch(() => undefined)
      this.adapterRestores.set(session.id, restore)
      void restore.finally(() => {
        if (this.adapterRestores.get(session.id) === restore) {
          this.adapterRestores.delete(session.id)
        }
      })
    }

    this.startWatchdog()
  }

  private async restoreAdapter(session: SessionMeta): Promise<void> {
    // Hooks for turn_done on later turns; do not fire session_start on restart.
    void this.hooks
      .loadForSession(session.id, session.cwd)
      .catch((err) => console.error("[hooks] load on restore failed", err))
    try {
      const adapter = getAdapter(session.provider)
      const resolved = this.settings.resolveInstance(
        session.instanceId ?? session.provider,
      )
      await adapter.start(
        {
          sessionId: session.id,
          cwd: session.cwd,
          title: session.title,
          binaryPath: resolved?.binaryPath,
          resumeId: session.agentSessionId,
        },
        this.callbacks(),
      )
    } catch (err) {
      // Missing binary / login — session stays visible; send() surfaces the error.
      console.warn(
        "[session-manager] restore adapter failed",
        session.id,
        err instanceof Error ? err.message : err,
      )
    }
  }

  getSnapshot(sessionIds?: readonly string[]): SessionSnapshot {
    const wanted = sessionIds ? new Set(sessionIds) : null
    const messages: Record<string, ChatMessage[]> = {}
    for (const [id, msgs] of this.messages) {
      if (wanted && !wanted.has(id)) continue
      messages[id] = msgs
    }
    const queued: Record<string, QueuedMessage[]> = {}
    for (const id of this.queued.keys()) {
      queued[id] = this.listQueued(id)
    }
    const rateLimits: Record<string, ProviderRateLimits> = {}
    for (const [id, limits] of this.rateLimits) {
      rateLimits[id] = limits
    }
    return {
      sessions: this.listSessions(),
      messages,
      queued,
      usage: this.usageTotals(),
      rateLimits,
      permissions: this.permissions?.list() ?? [],
      inputRequests: this.permissions?.listInputs() ?? [],
      activeSessionId: this.activeSessionId,
    }
  }

  usageTotals(): Record<string, SessionUsage> {
    const usage: Record<string, SessionUsage> = {}
    for (const [id, total] of this.usage) {
      usage[id] = total
    }
    return usage
  }

  getUsage(sessionId: string): SessionUsage | undefined {
    return this.usage.get(sessionId)
  }

  listSessions(): SessionMeta[] {
    return [...this.sessions.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )
  }

  getSession(id: string): SessionMeta | undefined {
    return this.sessions.get(id)
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.messages.get(sessionId) ?? []
  }

  async ensureMessagesLoaded(sessionIds?: readonly string[]): Promise<void> {
    const ids = sessionIds ?? [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.loadHot(id)))
  }

  private loadHot(sessionId: string): Promise<void> {
    if (this.hotLoaded.has(sessionId) || !this.sessions.has(sessionId)) {
      return Promise.resolve()
    }
    const running = this.hotLoads.get(sessionId)
    if (running) return running
    const load = this.persistence
      .loadHotMessages(sessionId)
      .then((stored) => {
        if (!this.sessions.has(sessionId) || this.hotLoaded.has(sessionId)) {
          return
        }
        this.hotLoaded.add(sessionId)
        const pending = this.messages.get(sessionId) ?? []
        const restored = stored.map((m) => ({ ...m, streaming: false }))
        this.messages.set(sessionId, [...restored, ...pending])
        if (pending.length > 0) this.scheduleSessionSave(sessionId)
      })
      .finally(() => {
        if (this.hotLoads.get(sessionId) === load) {
          this.hotLoads.delete(sessionId)
        }
      })
    this.hotLoads.set(sessionId, load)
    return load
  }

  setActiveSession(id: string | null): boolean {
    if (id && !this.sessions.has(id)) return false
    this.activeSessionId = id
    this.scheduleSave()
    this.bus.emit({
      type: "session.active",
      sessionId: id,
    })
    if (id) {
      this.bus.emit({
        type: "messages.replaced",
        sessionId: id,
        messages: this.getMessages(id),
      })
    }
    return true
  }

  async createSession(input: CreateSessionInput): Promise<SessionMeta> {
    const instanceId = input.instanceId ?? input.provider
    const resolved = this.settings.resolveInstance(instanceId)
    if (!resolved) {
      throw new Error(`Unknown provider/instance "${instanceId}"`)
    }
    const provider = resolved.provider
    const adapter = getAdapter(provider)
    // Availability honors a Settings binary-path override, not just PATH.
    const bin =
      provider === "mock"
        ? "mock"
        : resolveBinaryForSpawn(provider, resolved.binaryPath)
    if (!bin && !adapter.available) {
      throw new Error(
        `Provider "${provider}" is not available. Install the CLI, set a binary path in Settings, or pick another agent.`,
      )
    }

    const now = Date.now()
    const id = randomUUID()
    const baseCwd = resolveSessionCwd(input.cwd)
    const project = normalizeProject(input.project, baseCwd)
    let cwd = baseCwd
    let worktree: Awaited<ReturnType<typeof createSessionWorktree>> | undefined
    if (input.worktree) {
      worktree = await createSessionWorktree(baseCwd, id, input.title || project)
      cwd = worktree.cwd
    }
    const model =
      input.model?.trim() || resolved.defaultModel || undefined
    const session: SessionMeta = {
      id,
      title: input.title?.trim() || defaultTitle(provider, project, now),
      titleOrigin: input.title?.trim() ? "user" : "default",
      project,
      provider,
      instanceId,
      model,
      cwd,
      ...(worktree
        ? { baseCwd, branch: worktree.branch, worktreePath: worktree.path }
        : {}),
      status: "idle",
      activityAt: now,
      createdAt: now,
      updatedAt: now,
    }

    const previousActive = this.activeSessionId
    this.sessions.set(id, session)
    this.messages.set(id, [])
    this.hotLoaded.add(id)
    this.activeSessionId = id

    const cb = this.callbacks()
    try {
      await this.prepareBrowserTools(session)
      void this.noteUnignoredConfigs(session.id, session.cwd)
      await adapter.start(
        {
          sessionId: id,
          cwd: session.cwd,
          title: session.title,
          binaryPath: resolved.binaryPath,
        },
        cb,
      )
    } catch (err) {
      // start() throws on a missing binary: a session the UI never rendered must
      // not survive in the map and reappear from state.json after a restart.
      this.sessions.delete(id)
      this.messages.delete(id)
      this.hotLoaded.delete(id)
      this.dirtySessions.delete(id)
      this.activeSessionId = previousActive
      if (worktree) {
        await removeSessionWorktree(baseCwd, worktree.path).catch((cleanupErr) =>
          console.warn("[session-manager] worktree cleanup failed", cleanupErr),
        )
      }
      throw err
    }

    this.publishSessionEvent({ type: "session.upsert", session })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.bus.emit({
      type: "messages.replaced",
      sessionId: id,
      messages: [],
    })
    this.scheduleSave()

    // session_start hooks: load project `.chathub/hooks` then fire (non-blocking
    // so createSession stays snappy even if a shell hook is slow).
    void this.hooks
      .loadForSession(id, session.cwd)
      .then(() => this.hooks.run(id, "session_start"))
      .catch((err) => console.error("[hooks] session_start failed", err))

    if (worktree) this.beginWorktreeSetup(id, baseCwd, session.cwd)

    return session
  }

  private beginWorktreeSetup(
    sessionId: string,
    baseCwd: string,
    worktreeCwd: string,
  ): void {
    const token = this.nextTurnToken++
    this.turns.set(sessionId, { lastActivityAt: Date.now(), token })
    void this.worktreeSetup(baseCwd, worktreeCwd)
      .then((notes) => {
        if (!this.sessions.has(sessionId)) return
        for (const note of notes) this.systemNote(sessionId, note)
      })
      .catch((err) => {
        if (!this.sessions.has(sessionId)) return
        const detail = err instanceof Error ? err.message : String(err)
        this.systemNote(sessionId, `Worktree setup failed — ${detail}.`)
      })
      .finally(() => {
        if (!this.ownsTurn(sessionId, token)) return
        this.turns.delete(sessionId)
        this.flushQueued(sessionId)
      })
  }

  async sendMessage(
    sessionId: string,
    text: string,
    opts?: SendOpts,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")

    const content = text.trim()
    if (!content && !opts?.attachments?.length) return

    await this.loadHot(sessionId).catch(() => undefined)

    const attachments = inspectAttachmentPaths(opts?.attachments ?? [])
    const userContent = content || "(attachments)"
    const attachPreview = attachments.length > 0
      ? ` [attached: ${attachments.map((item) => item.name).join(", ")}]`
      : ""

    const userMsg: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: "user",
      content: userContent,
      createdAt: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
    }
    this.appendMessage(userMsg)
    this.touch(sessionId)
    this.unsettle(sessionId)
    this.publishSessionEvent({
      type: "session.message",
      id: sessionId,
      role: "user",
      preview: `${userContent}${attachPreview}`.slice(0, 160),
    })
    this.maybeAutoTitle(sessionId, userContent)

    // turns.has() as well as the status: dispatch() registers the turn
    // synchronously, while "running" only arrives once the adapter says so — two
    // quick sends would otherwise both dispatch and the adapter would reject the
    // second, failing the session while the first turn is still alive.
    if (this.turns.has(sessionId) || this.sessions.get(sessionId)?.status === "running") {
      // Sending now would pre-empt the live turn mid-tool-call and lose its work;
      // hold the text and hand it over when the turn reports back.
      const queue = this.queued.get(sessionId) ?? []
      queue.push({
        id: randomUUID(),
        content,
        createdAt: Date.now(),
        opts,
        userMessageId: userMsg.id,
      })
      this.queued.set(sessionId, queue)
      this.emitQueue(sessionId)
      return
    }

    await this.dispatch(sessionId, content, opts, userMsg.id)
  }

  private async dispatch(
    sessionId: string,
    content: string,
    opts?: SendOpts,
    userMessageId?: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    this.unsettle(sessionId)
    const adapter = getAdapter(session.provider)
    const permissionMode = this.permissionModeFor(session)
    const resolved = this.settings.resolveInstance(
      session.instanceId ?? session.provider,
    )
    const env = {
      ...(resolved?.env ?? {}),
      ...this.permissionEnv(session),
      ...this.hookIdentityEnv(session),
    }
    const token = this.nextTurnToken++
    this.turns.set(sessionId, { lastActivityAt: Date.now(), token })
    // Independent of each other, so reading `.chathub/context` costs the turn
    // no latency of its own — it overlaps the snapshot gate.
    const [systemPrompt] = await Promise.all([
      this.turnSystemPrompt(session),
      this.snapshotGate(session, content, userMessageId),
      this.adapterRestores.get(sessionId),
      this.prepareBrowserTools(session),
    ])
    // Stopping during the gate must not resurrect the turn it just killed.
    if (!this.ownsTurn(sessionId, token)) return
    // Fire-and-forget: stream/status arrive via event bus; UI stays responsive.
    void adapter
      .send(sessionId, content || "Please review the attached files.", this.callbacks(), {
        permissionMode,
        model: session.model,
        effort: opts?.effort,
        systemPrompt,
        attachments: opts?.attachments,
        binaryPath: resolved?.binaryPath,
        baseUrl: resolved?.baseUrl,
        history: adapter.wantsHistory
          ? this.conversationBefore(sessionId, userMessageId)
          : undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
      })
      .then(() => {
        if (!this.ownsTurn(sessionId, token)) return
        this.turns.delete(sessionId)
        // A CLI that dies non-zero resolves rather than rejects, so status is
        // the only witness that this turn failed.
        const failed = this.sessions.get(sessionId)?.status === "error"
        if (!failed && this.sessions.get(sessionId)?.status === "running") {
          this.applyStatus(sessionId, "idle")
        }
        this.flushQueued(sessionId)
        if (failed) return
        this.maybeRefineTitle(sessionId)
      })
      .catch((err) => {
        if (!this.ownsTurn(sessionId, token)) return
        this.turns.delete(sessionId)
        console.error("[session-manager] send failed", err)
        this.unsettle(sessionId)
        this.applyStatus(sessionId, "error")
        this.publishSessionEvent({
          type: "session.ended",
          id: sessionId,
          reason: "error",
        })
        this.dropQueued(sessionId, "the turn failed")
      })
  }

  private conversationBefore(
    sessionId: string,
    userMessageId?: string,
  ): ConversationTurn[] {
    const list = this.messages.get(sessionId) ?? []
    const currentIndex = userMessageId
      ? list.findIndex((m) => m.id === userMessageId)
      : -1
    const prior = currentIndex === -1 ? list.slice(0, -1) : list.slice(0, currentIndex)
    const turns: ConversationTurn[] = []
    for (const message of prior) {
      if (message.role !== "user" && message.role !== "assistant") continue
      if (!message.content.trim()) continue
      turns.push({ role: message.role, content: message.content })
    }
    return turns
  }

  /**
   * The mode's prompt plus the project's `.chathub/context` brief, when the
   * project shares it. Read per turn rather than cached on the session: the
   * owner (or the agent itself) edits those files mid-session, and the next send
   * should carry what the files say now. `projectContextBrief` never throws, so
   * an unreadable context costs the turn nothing.
   */
  private async turnSystemPrompt(
    session: SessionMeta,
  ): Promise<string | undefined> {
    const brief = await projectContextBrief(session.cwd)
    const parts = [session.systemPrompt, brief]
      .map((part) => part?.trim() ?? "")
      .filter((part) => part !== "")
    return parts.length > 0 ? parts.join("\n\n") : undefined
  }

  /**
   * Hold the send until the snapshot is on disk, so the checkpoint holds the
   * tree as it was before the agent could touch it. A repo slower than the gate
   * keeps the old best-effort behaviour: the send goes out and the snapshot
   * still stamps its message, just without the ordering guarantee.
   */
  private snapshotGate(
    session: SessionMeta,
    content: string,
    userMessageId?: string,
  ): Promise<void> {
    const snapshot = this.snapshotTurn(session, content, userMessageId).catch(
      () => undefined,
    )
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CHECKPOINT_GATE_MS)
      void snapshot.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * Best-effort by contract: a failed or unavailable checkpoint (a non-git
   * folder is the common one) must never block or fail the turn.
   */
  private async snapshotTurn(
    session: SessionMeta,
    content: string,
    userMessageId?: string,
  ): Promise<void> {
    let checkpoint: Awaited<ReturnType<typeof createCheckpoint>>
    try {
      checkpoint = await createCheckpoint(
        session.cwd,
        session.id,
        content || "attachments",
      )
    } catch (err) {
      console.warn("[session-manager] checkpoint failed", session.id, err)
      return
    }
    if (!checkpoint) return
    if (userMessageId) {
      const list = this.messages.get(session.id)
      const idx = list?.findIndex((m) => m.id === userMessageId) ?? -1
      if (list && idx !== -1) {
        list[idx] = { ...list[idx], checkpointRef: checkpoint.ref }
        this.bus.emit({
          type: "messages.replaced",
          sessionId: session.id,
          messages: [...list],
        })
        this.scheduleSessionSave(session.id)
      }
    }
    void pruneCheckpoints(
      session.cwd,
      session.id,
      MAX_CHECKPOINTS_PER_SESSION,
    ).catch((err) => {
      console.warn("[session-manager] checkpoint prune failed", session.id, err)
    })
  }

  /**
   * Roll files and transcript back to the snapshot taken before `ref`'s turn.
   * Refused while a turn is live — reverting under a writing agent would race
   * its edits. The CLI's own resumed conversation still remembers the reverted
   * turns; only the workspace and the visible transcript go back.
   */
  async revertToCheckpoint(sessionId: string, ref: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    if (this.turns.has(sessionId) || session.status === "running") {
      throw new Error("Stop the running turn before reverting")
    }
    await this.loadHot(sessionId).catch(() => undefined)
    await revertToCheckpoint(session.cwd, sessionId, ref)

    const list = this.messages.get(sessionId) ?? []
    const idx = list.findIndex((m) => m.checkpointRef === ref)
    if (idx !== -1) {
      let kept = list.slice(0, idx)
      // An empty window would tell the renderer to drop the archived head it
      // scrolled in, though every archived turn predates the revert point and
      // must survive it — so refill from the archive instead of sending [].
      if (kept.length === 0 && idx === 0) {
        const page = await this.loadArchivedMessages(
          sessionId,
          list[0]?.id ?? null,
          ARCHIVE_REFILL_LIMIT,
        ).catch(() => ({ messages: [] as ChatMessage[] }))
        kept = page.messages
      }
      this.messages.set(sessionId, kept)
      this.scheduleSessionSave(sessionId)
      this.bus.emit({
        type: "messages.replaced",
        sessionId,
        messages: kept,
      })
    }
    this.touch(sessionId)
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
  }

  /**
   * Point the CLI's agent-desktop hook at the Hub's socket so its permission
   * prompts land in the transcript. Only the two CLIs that speak the blocking
   * hook protocol: for OpenCode the same variable addresses its plugin's event
   * push, which belongs to the island, not to us.
   */
  private permissionEnv(session: SessionMeta): Record<string, string> {
    const socket = this.permissions?.socketPath
    if (!socket) return {}
    if (session.provider !== "claude" && session.provider !== "codex") return {}
    return { AGENT_DESKTOP_SOCKET: socket }
  }

  /**
   * The user's globally-installed Claude Code hook fires for the `claude` we
   * spawn too, so one Hub turn used to raise two island cards — ours, plus the
   * hook's, mislabelled "Terminal" because a spawned CLI has no TERM_PROGRAM.
   * Handing the hook our session id makes both producers write the same card,
   * which keeps the hook's richer data (tool activity, permissions) on it.
   */
  private hookIdentityEnv(session: SessionMeta): Record<string, string> {
    return {
      AGENT_DESKTOP_HUB_SESSION: session.id,
      AGENT_DESKTOP_HUB_BUNDLE: "com.agentdesktop.ChatHub",
    }
  }

  /** Hand the next queued message to the adapter now that the turn is over. */
  private flushQueued(sessionId: string): void {
    const queue = this.queued.get(sessionId)
    const next = queue?.shift()
    if (!next) return
    if (queue && queue.length === 0) this.queued.delete(sessionId)
    this.emitQueue(sessionId)
    void this.dispatch(sessionId, next.content, next.opts, next.userMessageId)
  }

  /** Never leave the user guessing whether a queued message was delivered. */
  private dropQueued(sessionId: string, reason: string): void {
    const queue = this.queued.get(sessionId)
    if (!queue || queue.length === 0) return
    this.queued.delete(sessionId)
    this.emitQueue(sessionId)
    this.systemNote(
      sessionId,
      `${queue.length} queued message(s) were not sent — ${reason}.`,
    )
  }

  /** Undelivered follow-ups, oldest first. The renderer renders exactly this. */
  listQueued(sessionId: string): QueuedMessage[] {
    return (this.queued.get(sessionId) ?? []).map((q) => ({
      id: q.id,
      sessionId,
      text: q.content,
      createdAt: q.createdAt,
    }))
  }

  /** Take a follow-up back out of the queue before it reaches the CLI. */
  cancelQueued(sessionId: string, queuedId: string): QueuedMessage[] {
    const queue = this.queued.get(sessionId)
    if (queue) {
      const next = queue.filter((q) => q.id !== queuedId)
      if (next.length === 0) this.queued.delete(sessionId)
      else this.queued.set(sessionId, next)
      if (next.length !== queue.length) this.emitQueue(sessionId)
    }
    return this.listQueued(sessionId)
  }

  private emitQueue(sessionId: string): void {
    this.bus.emit({
      type: "queue.changed",
      sessionId,
      queued: this.listQueued(sessionId),
    })
  }

  async abortSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.turns.delete(sessionId)
    // A CLI-style interactive question has no child process while the user is
    // deciding. Resolve it before aborting the adapter so it cannot resurrect
    // the just-stopped turn when its promise settles.
    this.permissions?.cancelForSession(sessionId)
    await getAdapter(session.provider).abort(sessionId)
    this.applyStatus(sessionId, "idle")
    this.dropQueued(sessionId, "the turn was stopped")
  }

  /**
   * Quit path: the CLIs run detached (own process group), so nothing signals them
   * when Electron exits — a YOLO agent would keep editing the repo with no UI.
   */
  async shutdown(): Promise<void> {
    this.stopWatchdog()
    const live = [...this.sessions.values()].filter(
      (s) => s.status === "running" || this.turns.has(s.id),
    )
    await Promise.all(
      live.map(async (s) => {
        try {
          await getAdapter(s.provider).abort(s.id)
        } catch (err) {
          console.warn("[session-manager] abort on quit failed", s.id, err)
        }
      }),
    )
    this.turns.clear()
    // The queue is in-memory only: say so in the transcript before quitting,
    // otherwise the user comes back to their own message that never ran.
    for (const id of [...this.queued.keys()]) {
      this.dropQueued(id, "Chat Hub quit")
    }
    for (const s of live) {
      this.applyStatus(s.id, "idle")
    }
    await this.flush()
    await this.bridge.flush()
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return
    this.watchdogTimer = setInterval(
      () => this.checkStuckSessions(),
      this.watchdog.intervalMs,
    )
    // A background timer must not keep the process alive on its own.
    this.watchdogTimer.unref?.()
  }

  private stopWatchdog(): void {
    if (!this.watchdogTimer) return
    clearInterval(this.watchdogTimer)
    this.watchdogTimer = null
  }

  /**
   * A session must never sit in "running" with nothing behind it: either no turn
   * owns it (process gone / never started) or the CLI went silent for good.
   * Public so the behaviour is testable without waiting for the interval.
   */
  checkStuckSessions(now = Date.now()): void {
    for (const session of [...this.sessions.values()]) {
      if (session.status !== "running") continue
      const turn = this.turns.get(session.id)
      if (!turn) {
        this.systemNote(
          session.id,
          "Marked idle — no agent process is attached to this session.",
        )
        this.applyStatus(session.id, "idle")
        this.dropQueued(session.id, "the session had no live process")
        continue
      }
      if (now - turn.lastActivityAt < this.watchdog.silenceMs) continue

      this.turns.delete(session.id)
      try {
        void getAdapter(session.provider)
          .abort(session.id)
          .catch(() => undefined)
      } catch {
        /* provider gone — the status fix below still matters */
      }
      const minutes = Math.round(this.watchdog.silenceMs / 60_000)
      this.systemNote(
        session.id,
        `Marked failed — no output from ${session.provider} for ${minutes} min. The process was stopped.`,
      )
      this.unsettle(session.id)
      this.applyStatus(session.id, "error")
      this.publishSessionEvent({
        type: "session.ended",
        id: session.id,
        reason: "error",
      })
      this.dropQueued(session.id, "the turn stopped responding")
    }
  }

  /** A line in the transcript from the Hub itself, not from any agent. */
  note(sessionId: string, content: string): void {
    if (!this.sessions.has(sessionId)) return
    this.systemNote(sessionId, content)
  }

  private systemNote(sessionId: string, content: string): void {
    this.appendMessage({
      id: randomUUID(),
      sessionId,
      role: "system",
      content,
      createdAt: Date.now(),
    })
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    try {
      await getAdapter(session.provider).dispose(sessionId)
    } catch {
      // ignore dispose errors
    }

    await deleteSessionCheckpoints(session.cwd, sessionId).catch((err) =>
      console.warn("[session-manager] checkpoint cleanup skipped", err),
    )
    if (session.worktreePath && session.baseCwd) {
      await removeSessionWorktree(session.baseCwd, session.worktreePath).catch((err) =>
        console.warn("[session-manager] worktree cleanup skipped", err),
      )
    }

    this.sessions.delete(sessionId)
    this.messages.delete(sessionId)
    this.turns.delete(sessionId)
    this.queued.delete(sessionId)
    this.usage.delete(sessionId)
    this.configNoted.delete(sessionId)
    this.browserToolsReady.delete(sessionId)
    this.adapterRestores.delete(sessionId)
    await this.discardHot(sessionId)
    await this.discardArchive(sessionId)
    this.hooks.clearSession(sessionId)
    // The CLI is dead, so nothing is left to answer its permission any more.
    this.permissions?.cancelForSession(sessionId)
    if (this.activeSessionId === sessionId) {
      const next = this.listSessions()[0]
      this.activeSessionId = next?.id ?? null
    }

    this.publishSessionEvent({
      type: "session.ended",
      id: sessionId,
      reason: "killed",
    })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
  }

  /** Remove every session + transcript. Used by Settings → Advanced → Reset. */
  async wipeSessions(): Promise<void> {
    const ids = [...this.sessions.keys()]
    for (const id of ids) {
      this.permissions?.cancelForSession(id)
      try {
        await getAdapter(this.sessions.get(id)!.provider).dispose(id)
      } catch {
        /* ignore */
      }
      this.publishSessionEvent({ type: "session.ended", id, reason: "killed" })
      const session = this.sessions.get(id)
      if (session) {
        await deleteSessionCheckpoints(session.cwd, id).catch((err) =>
          console.warn("[session-manager] checkpoint cleanup skipped", err),
        )
      }
      if (session?.worktreePath && session.baseCwd) {
        await removeSessionWorktree(session.baseCwd, session.worktreePath).catch((err) =>
          console.warn("[session-manager] worktree cleanup skipped", err),
        )
      }
    }
    this.sessions.clear()
    this.messages.clear()
    this.turns.clear()
    this.queued.clear()
    this.usage.clear()
    this.configNoted.clear()
    this.browserToolsReady.clear()
    this.adapterRestores.clear()
    for (const id of ids) await this.discardHot(id)
    for (const id of ids) await this.discardArchive(id)
    for (const id of ids) this.hooks.clearSession(id)
    this.activeSessionId = null
    this.bus.emit({ type: "sessions.replaced", sessions: [] })
    this.bus.emit({ type: "session.active", sessionId: null })
    await this.flush()
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.dirtyIndex = true
    await this.flushDirty()
  }

  private callbacks(): AdapterCallbacks {
    return {
      onSessionEvent: (event) => {
        if ("id" in event) this.markActivity(event.id)
        if (event.type === "session.status") {
          this.applyStatus(event.id, event.status)
          return
        }
        if (event.type === "session.upsert") {
          this.sessions.set(event.session.id, event.session)
          this.publishSessionEvent(event)
          this.bus.emit({
            type: "sessions.replaced",
            sessions: this.listSessions(),
          })
          this.scheduleSave()
          return
        }
        this.publishSessionEvent(event)
      },
      onMessage: (message) => {
        this.markActivity(message.sessionId)
        this.appendMessage(message)
        this.touch(message.sessionId)
        this.scheduleSave()
      },
      onDelta: (sessionId, messageId, delta) => {
        this.markActivity(sessionId)
        const list = this.messages.get(sessionId)
        if (!list) return
        const idx = list.findIndex((m) => m.id === messageId)
        if (idx === -1) return
        const prev = list[idx]
        list[idx] = {
          ...prev,
          content: prev.content + delta,
          streaming: true,
        }
        this.bus.emit({
          type: "chat.delta",
          sessionId,
          messageId,
          delta,
        })
        this.touch(sessionId)
      },
      onStreamDone: (sessionId, messageId) => {
        this.markActivity(sessionId)
        const list = this.messages.get(sessionId)
        if (list) {
          const idx = list.findIndex((m) => m.id === messageId)
          if (idx !== -1) {
            list[idx] = { ...list[idx], streaming: false }
          }
        }
        this.bus.emit({ type: "chat.done", sessionId, messageId })
        this.scheduleSessionSave(sessionId)
        // turn_done after the stream has actually finished; never blocks the turn.
        void this.hooks
          .run(sessionId, "turn_done")
          .catch((err) => console.error("[hooks] turn_done failed", err))
      },
      onTurnItem: (sessionId, messageId, item) => {
        this.markActivity(sessionId)
        const list = this.messages.get(sessionId)
        if (!list) return
        const idx = list.findIndex((m) => m.id === messageId)
        if (idx === -1) return
        const message = list[idx]
        const items = [...(message.items ?? [])]
        const itemIdx = items.findIndex((candidate) => candidate.id === item.id)
        if (itemIdx === -1) items.push(item)
        else items[itemIdx] = item
        list[idx] = { ...message, items }
        this.bus.emit({
          type: "chat.item",
          sessionId,
          messageId,
          item,
        })
        this.touch(sessionId)
        this.scheduleSave()
        this.scheduleSessionSave(sessionId)
        if (item.kind === "plan" && item.steps && item.steps.length > 0) {
          const cwd = this.sessions.get(sessionId)?.cwd
          if (cwd) this.queuePlanBoard(cwd, item.steps)
        }
      },
      onPermissionRequest: async (request) => {
        if (!this.permissions) return "deny"
        return this.permissions.requestFromAdapter(request)
      },
      onUserInputRequest: async (request) => {
        if (!this.permissions) return {}
        return this.permissions.requestInputFromAdapter(request)
      },
      onServerRequestResolved: (requestIds) => {
        this.permissions?.resolveExternally(requestIds)
      },
      onUsage: (sessionId, turn, messageId) => {
        this.recordUsage(sessionId, turn, messageId)
      },
      onRateLimits: (sessionId, limits) => {
        if (!this.sessions.has(sessionId)) return
        this.rateLimits.set(sessionId, limits)
        this.bus.emit({ type: "limits.changed", sessionId, limits })
      },
      onAgentSession: (sessionId, agentSessionId) => {
        const s = this.sessions.get(sessionId)
        if (!s || s.agentSessionId === agentSessionId) return
        // Persist for cross-restart resume; no visible change → no re-render.
        this.sessions.set(sessionId, { ...s, agentSessionId })
        this.scheduleSave()
      },
    }
  }

  /**
   * Fold a finished turn into the session total and stamp it on the assistant
   * message, so the footer shows the session and the transcript shows the turn.
   */
  private recordUsage(
    sessionId: string,
    turn: TurnUsage,
    messageId?: string,
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const total = addUsage(this.usage.get(sessionId), turn)
    this.usage.set(sessionId, total)
    void this.usageLedger?.record(session.provider, session.model, turn, session.id)

    const list = this.messages.get(sessionId)
    const idx = messageId ? (list?.findIndex((m) => m.id === messageId) ?? -1) : -1
    if (list && idx !== -1) {
      list[idx] = { ...list[idx], usage: turn }
      this.scheduleSessionSave(sessionId)
    }
    this.bus.emit({
      type: "usage.changed",
      sessionId,
      messageId: idx === -1 ? undefined : messageId,
      turn,
      total,
    })
    this.scheduleSave()
  }

  private applyStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id)
    if (!session) return
    // Ask-mode pending input wins over idle/running so the Wait filter stays true.
    let effective = status
    if (
      this.hasPendingInput(id) &&
      status !== "error" &&
      status !== "done" &&
      status !== "waiting_input"
    ) {
      effective = "waiting_input"
    }
    if (session.status === effective) {
      this.publishSessionEvent({
        type: "session.status",
        id,
        status: effective,
        at: session.activityAt ?? session.updatedAt,
      })
      return
    }
    const at = Date.now()
    const next = { ...session, status: effective, activityAt: at, updatedAt: at }
    this.sessions.set(id, next)
    this.publishSessionEvent({ type: "session.status", id, status: effective, at })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
  }

  private hasPendingInput(sessionId: string): boolean {
    // Tests sometimes stub the broker with only socketPath/env helpers.
    const list = this.permissions?.listInputs?.() ?? []
    return list.some((r) => r.sessionId === sessionId)
  }

  /**
   * Reflect Ask-mode pendingInputs as SessionStatus.waiting_input.
   * When the last input closes: running if a turn is still live, else idle.
   */
  private syncWaitingInputStatus(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    if (this.hasPendingInput(sessionId)) {
      this.applyStatus(sessionId, "waiting_input")
      return
    }
    const session = this.sessions.get(sessionId)
    if (!session || session.status !== "waiting_input") return
    this.applyStatus(sessionId, this.turns.has(sessionId) ? "running" : "idle")
  }

  private appendMessage(message: ChatMessage): void {
    if (!this.hotLoaded.has(message.sessionId)) {
      void this.loadHot(message.sessionId).catch(() => undefined)
    }
    const list = this.messages.get(message.sessionId) ?? []
    list.push(message)
    const overflow: ChatMessage[] = []
    while (list.length > this.maxMessages) {
      const old = list.shift()
      if (old) overflow.push(old)
    }
    this.messages.set(message.sessionId, list)
    this.scheduleSessionSave(message.sessionId)
    this.bus.emit({ type: "chat.message", message })
    if (overflow.length > 0) {
      this.archivedSessions.add(message.sessionId)
      this.queueArchiveAppend(message.sessionId, overflow)
    }
  }

  private async discardHot(sessionId: string): Promise<void> {
    this.dirtySessions.delete(sessionId)
    this.hotLoaded.delete(sessionId)
    await this.hotLoads.get(sessionId)?.catch(() => undefined)
    this.hotLoads.delete(sessionId)
    await this.hotWrites.get(sessionId)?.catch(() => undefined)
    this.hotWrites.delete(sessionId)
  }

  private async discardArchive(sessionId: string): Promise<void> {
    await this.archiveWrites.get(sessionId)?.catch(() => undefined)
    this.archiveWrites.delete(sessionId)
    this.archivedSessions.delete(sessionId)
    await this.archive
      .remove(sessionId)
      .catch((err) => console.warn("[archive] remove failed", sessionId, err))
  }

  private queueArchiveAppend(sessionId: string, messages: ChatMessage[]): void {
    const previous = this.archiveWrites.get(sessionId) ?? Promise.resolve()
    const write = previous
      .catch(() => undefined)
      .then(() => this.archive.append(sessionId, messages))
    this.archiveWrites.set(sessionId, write)
    void write
      .catch((err) => console.error("[archive] append failed", sessionId, err))
      .finally(() => {
        if (this.archiveWrites.get(sessionId) === write) {
          this.archiveWrites.delete(sessionId)
        }
      })
  }

  /** Any sign of life from the CLI resets the watchdog's silence timer. */
  private markActivity(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (turn) turn.lastActivityAt = Date.now()
  }

  private touch(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    const at = Date.now()
    this.sessions.set(id, { ...session, activityAt: at, updatedAt: at })
  }

  private publishSessionEvent(
    event: import("@shared/types").SessionEvent,
  ): void {
    this.bus.emitSession(event)
    // The island decides a card's host from `source`; without it every Hub
    // session had to be guessed at from an empty focusApp. Stamped here so no
    // upsert site can forget it.
    this.bridge.publish(
      event.type === "session.upsert"
        ? { ...event, session: { ...event.session, source: "hub" } }
        : event,
    )
    this.notifications.handle(event)
  }

  private toIndex(): PersistedIndex {
    const usage: Record<string, SessionUsage> = {}
    for (const [id, total] of this.usage) {
      usage[id] = total
    }
    return {
      version: 1,
      sessions: this.listSessions(),
      usage,
      activeSessionId: this.activeSessionId,
    }
  }

  private hotOf(sessionId: string): ChatMessage[] {
    return (this.messages.get(sessionId) ?? []).map((m) => {
      const { streaming: _streaming, ...rest } = m
      void _streaming
      return rest
    })
  }

  private queuePlanBoard(
    cwd: string,
    steps: { text: string; status: string; id?: string }[],
  ): void {
    const prev = this.planBoardTimers.get(cwd)
    if (prev) clearTimeout(prev)
    this.planBoardTimers.set(
      cwd,
      setTimeout(() => {
        this.planBoardTimers.delete(cwd)
        void applyPlanToBoard(cwd, steps).catch((err) => {
          console.error("[board] plan mirror failed", err)
        })
      }, 400),
    )
  }

  private scheduleSave(): void {
    this.dirtyIndex = true
    this.armSaveTimer()
  }

  private scheduleSessionSave(sessionId: string): void {
    this.dirtySessions.add(sessionId)
    this.armSaveTimer()
  }

  private armSaveTimer(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flushDirty().catch((err) => {
        console.error("[persistence] save failed", err)
      })
    }, 250)
  }

  private flushDirty(): Promise<void> {
    const writes: Promise<void>[] = []
    if (this.dirtyIndex) {
      this.dirtyIndex = false
      writes.push(this.persistence.saveIndex(this.toIndex()))
    }
    const ids = [...this.dirtySessions]
    this.dirtySessions.clear()
    for (const id of ids) {
      if (!this.sessions.has(id) || !this.hotLoaded.has(id)) continue
      const previous = this.hotWrites.get(id) ?? Promise.resolve()
      const write = previous
        .catch(() => undefined)
        .then(() => this.persistence.saveHotMessages(id, this.hotOf(id)))
      this.hotWrites.set(id, write)
      void write.finally(() => {
        if (this.hotWrites.get(id) === write) {
          this.hotWrites.delete(id)
        }
      })
      writes.push(write)
    }
    return Promise.all(writes).then(() => undefined)
  }
}

function defaultTitle(
  provider: ProviderId,
  project: string,
  now: number,
): string {
  const t = new Date(now)
  const hh = String(t.getHours()).padStart(2, "0")
  const mm = String(t.getMinutes()).padStart(2, "0")
  return `${project} · ${provider} · ${hh}:${mm}`
}

function resolveSessionCwd(input?: string): string {
  const raw = input?.trim()
  // Never fall back to process.cwd(): for the packaged app that is "/", which
  // would root a YOLO agent at the filesystem root.
  if (!raw) {
    throw new Error("Project folder required — pick one before starting a session")
  }
  try {
    const real = realpathSync(raw)
    if (!statSync(real).isDirectory()) {
      throw new Error(`Not a directory: ${raw}`)
    }
    return real
  } catch (err) {
    throw new Error(
      `Invalid project folder: ${raw} (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    )
  }
}

/** Reject seeded fake paths like /Users/dev/projects/... */
function cwdLooksReal(cwd: string): boolean {
  if (!cwd || cwd.includes("/Users/dev/")) return false
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}
