import { randomUUID } from "node:crypto"
import type {
  ChatMessage,
  CreateSessionInput,
  ProviderId,
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
import type { AdapterCallbacks, EffortLevel } from "./adapters/types"
import type { EventBus } from "./event-bus"
import type { SessionMonitorBridge } from "./bridge"
import type { NotificationService } from "./notifications"
import type { Persistence, PersistedState } from "./persistence"
import { buildDemoState } from "./demo-seed"
import { addUsage } from "./adapters/usage"
import type { PermissionBroker } from "./permission-broker"
import { realpathSync, statSync } from "node:fs"
import type { PermissionMode } from "@shared/permission"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import type { SettingsStore } from "./settings"
import { HookRunner } from "./hooks"
import { inspectAttachmentPaths } from "./attachments"
import { MessageArchive, type ArchivedContext } from "./message-archive"
import {
  MIN_TRANSCRIPT_QUERY,
  type ArchiveSearchResult,
  type TranscriptHit,
} from "@shared/search"
import { createSessionWorktree, removeSessionWorktree } from "./git"
import { runWorktreeCreateScripts } from "./surfaces/scripts"

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
type QueuedTurn = { id: string; content: string; createdAt: number; opts?: SendOpts }

/** Runs a fresh worktree's setup scripts; returns transcript notice lines. */
export type WorktreeSetupRunner = (
  baseCwd: string,
  worktreeCwd: string,
) => Promise<string[]>

export class SessionManager {
  private sessions = new Map<string, SessionMeta>()
  private messages = new Map<string, ChatMessage[]>()
  private activeSessionId: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  /** In-flight turns: presence means a live adapter process belongs to the id. */
  private turns = new Map<string, { lastActivityAt: number }>()
  private queued = new Map<string, QueuedTurn[]>()
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private usage = new Map<string, SessionUsage>()
  private permissions: PermissionBroker | null = null
  private registerBrowserMcp: BrowserMcpRegistrar | null = null
  private readonly hooks: HookRunner
  private readonly archive: MessageArchive
  /** Live-window cap; overridable in tests so overflow is cheap to exercise. */
  private readonly maxMessages: number
  /** Sessions that have spilled into archive.jsonl (or already had one on disk). */
  private archivedSessions = new Set<string>()
  /** Preserve archive order and let an immediate scroll-back wait for its write. */
  private archiveWrites = new Map<string, Promise<void>>()
  private inputStatusWired = false
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
      worktreeSetup?: WorktreeSetupRunner
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
    this.worktreeSetup = opts?.worktreeSetup ?? runWorktreeCreateScripts
  }

  /**
   * Writes the built-in browser MCP server into the session's project config.
   * A CLI reads that config at process start, so every call site must await
   * this before `adapter.start`, and a failure must never block the spawn.
   */
  setBrowserMcpRegistrar(register: BrowserMcpRegistrar): void {
    this.registerBrowserMcp = register
  }

  private async prepareBrowserTools(session: BrowserMcpTarget): Promise<void> {
    if (!this.registerBrowserMcp) return
    try {
      await this.registerBrowserMcp(session)
    } catch (err) {
      console.warn("[session-manager] browser mcp registration failed", err)
    }
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

    const hits: TranscriptHit[] = []
    let truncated = false
    for (const sessionId of this.archivedSessions) {
      if (!this.sessions.has(sessionId)) continue
      const found = await this.archive.search(
        sessionId,
        q,
        loadedFrom[sessionId] ?? null,
      )
      if (found.truncated) truncated = true
      if (found.hit) hits.push(found.hit)
    }
    return { hits, truncated }
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

  setSessionTitle(sessionId: string, title: string): SessionMeta {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")
    const t = title.trim()
    if (!t) throw new Error("Title required")
    const next = { ...session, title: t, updatedAt: Date.now() }
    this.sessions.set(sessionId, next)
    this.publishSessionEvent({ type: "session.upsert", session: next })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
    return next
  }

  async init(): Promise<void> {
    if (this.started) return
    this.started = true

    let state = await this.persistence.load()
    // Demo seed only when explicitly requested (not for daily driver).
    if (state.sessions.length === 0 && process.env.CHAT_HUB_DEMO === "1") {
      const demo = buildDemoState()
      state = {
        version: 1,
        sessions: demo.sessions,
        messages: demo.messages,
        activeSessionId: demo.activeSessionId,
      }
      await this.persistence.save(state)
    }

    for (const session of state.sessions) {
      // Drop demo / missing project paths — only real folders survive restart.
      const cwd = session.cwd || ""
      if (!cwdLooksReal(cwd)) {
        continue
      }
      // Never restore as stuck running without a live process.
      const status: SessionStatus =
        session.status === "running" ? "idle" : session.status
      this.sessions.set(session.id, {
        ...session,
        cwd,
        project: session.project || normalizeProject(undefined, cwd),
        status,
      })
    }
    for (const [id, msgs] of Object.entries(state.messages)) {
      if (!this.sessions.has(id)) continue
      this.messages.set(
        id,
        msgs.map((m) => ({ ...m, streaming: false })),
      )
    }
    for (const [id, total] of Object.entries(state.usage ?? {})) {
      if (this.sessions.has(id)) this.usage.set(id, total)
    }
    this.activeSessionId = state.activeSessionId
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

    // Re-register restored sessions with their adapter so follow-up turns work
    // after a restart (otherwise send() throws "Session not started"), seeding
    // the persisted CLI session id for resume.
    for (const session of this.listSessions()) {
      await this.restoreAdapter(session)
      if (await this.archive.hasArchive(session.id)) {
        this.archivedSessions.add(session.id)
      }
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
      await this.prepareBrowserTools(session)
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

  getSnapshot(): SessionSnapshot {
    const messages: Record<string, ChatMessage[]> = {}
    for (const [id, msgs] of this.messages) {
      messages[id] = msgs
    }
    const queued: Record<string, QueuedMessage[]> = {}
    for (const id of this.queued.keys()) {
      queued[id] = this.listQueued(id)
    }
    const usage: Record<string, SessionUsage> = {}
    for (const [id, total] of this.usage) {
      usage[id] = total
    }
    return {
      sessions: this.listSessions(),
      messages,
      queued,
      usage,
      permissions: this.permissions?.list() ?? [],
      inputRequests: this.permissions?.listInputs() ?? [],
      activeSessionId: this.activeSessionId,
    }
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
      project,
      provider,
      instanceId,
      model,
      cwd,
      ...(worktree
        ? { baseCwd, branch: worktree.branch, worktreePath: worktree.path }
        : {}),
      status: "idle",
      createdAt: now,
      updatedAt: now,
    }

    const previousActive = this.activeSessionId
    this.sessions.set(id, session)
    this.messages.set(id, [])
    this.activeSessionId = id

    const cb = this.callbacks()
    try {
      await this.prepareBrowserTools(session)
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
    this.turns.set(sessionId, { lastActivityAt: Date.now() })
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
    this.publishSessionEvent({
      type: "session.message",
      id: sessionId,
      role: "user",
      preview: `${userContent}${attachPreview}`.slice(0, 160),
    })

    // turns.has() as well as the status: dispatch() registers the turn
    // synchronously, while "running" only arrives once the adapter says so — two
    // quick sends would otherwise both dispatch and the adapter would reject the
    // second, failing the session while the first turn is still alive.
    if (this.turns.has(sessionId) || this.sessions.get(sessionId)?.status === "running") {
      // Sending now would pre-empt the live turn mid-tool-call and lose its work;
      // hold the text and hand it over when the turn reports back.
      const queue = this.queued.get(sessionId) ?? []
      queue.push({ id: randomUUID(), content, createdAt: Date.now(), opts })
      this.queued.set(sessionId, queue)
      this.emitQueue(sessionId)
      return
    }

    this.dispatch(sessionId, content, opts)
  }

  private dispatch(sessionId: string, content: string, opts?: SendOpts): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

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
    this.turns.set(sessionId, { lastActivityAt: Date.now() })
    // Fire-and-forget: stream/status arrive via event bus; UI stays responsive.
    void adapter
      .send(sessionId, content || "Please review the attached files.", this.callbacks(), {
        permissionMode,
        model: session.model,
        effort: opts?.effort,
        systemPrompt: session.systemPrompt,
        attachments: opts?.attachments,
        binaryPath: resolved?.binaryPath,
        env: Object.keys(env).length > 0 ? env : undefined,
      })
      .then(() => {
        this.turns.delete(sessionId)
        if (this.sessions.get(sessionId)?.status === "running") {
          this.applyStatus(sessionId, "idle")
        }
        this.flushQueued(sessionId)
      })
      .catch((err) => {
        this.turns.delete(sessionId)
        console.error("[session-manager] send failed", err)
        this.applyStatus(sessionId, "error")
        this.publishSessionEvent({
          type: "session.ended",
          id: sessionId,
          reason: "error",
        })
        this.dropQueued(sessionId, "the turn failed")
      })
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
    this.dispatch(sessionId, next.content, next.opts)
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
      this.applyStatus(session.id, "error")
      this.publishSessionEvent({
        type: "session.ended",
        id: session.id,
        reason: "error",
      })
      this.dropQueued(session.id, "the turn stopped responding")
    }
  }

  private systemNote(sessionId: string, content: string): void {
    this.appendMessage({
      id: randomUUID(),
      sessionId,
      role: "system",
      content,
      createdAt: Date.now(),
    })
    this.scheduleSave()
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    try {
      await getAdapter(session.provider).dispose(sessionId)
    } catch {
      // ignore dispose errors
    }

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
    await this.persistence.save(this.toPersisted())
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
        this.scheduleSave()
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
    if (!this.sessions.has(sessionId)) return
    const total = addUsage(this.usage.get(sessionId), turn)
    this.usage.set(sessionId, total)

    const list = this.messages.get(sessionId)
    const idx = messageId ? (list?.findIndex((m) => m.id === messageId) ?? -1) : -1
    if (list && idx !== -1) {
      list[idx] = { ...list[idx], usage: turn }
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
      this.publishSessionEvent({ type: "session.status", id, status: effective })
      return
    }
    const next = { ...session, status: effective, updatedAt: Date.now() }
    this.sessions.set(id, next)
    this.publishSessionEvent({ type: "session.status", id, status: effective })
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
    const list = this.messages.get(message.sessionId) ?? []
    list.push(message)
    const overflow: ChatMessage[] = []
    while (list.length > this.maxMessages) {
      const old = list.shift()
      if (old) overflow.push(old)
    }
    this.messages.set(message.sessionId, list)
    this.bus.emit({ type: "chat.message", message })
    if (overflow.length > 0) {
      this.archivedSessions.add(message.sessionId)
      this.queueArchiveAppend(message.sessionId, overflow)
    }
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
    this.sessions.set(id, { ...session, updatedAt: Date.now() })
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

  private toPersisted(): PersistedState {
    const messages: Record<string, ChatMessage[]> = {}
    for (const [id, msgs] of this.messages) {
      messages[id] = msgs.map((m) => {
        const { streaming: _streaming, ...rest } = m
        void _streaming
        return rest
      })
    }
    const usage: Record<string, SessionUsage> = {}
    for (const [id, total] of this.usage) {
      usage[id] = total
    }
    return {
      version: 1,
      sessions: this.listSessions(),
      messages,
      usage,
      activeSessionId: this.activeSessionId,
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persistence.save(this.toPersisted()).catch((err) => {
        console.error("[persistence] save failed", err)
      })
    }, 250)
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
