import { randomUUID } from "node:crypto"
import type {
  ChatMessage,
  CreateSessionInput,
  ProviderId,
  SessionMeta,
  SessionSnapshot,
  SessionStatus,
} from "@shared/types"
import { normalizeProject } from "@shared/project"
import { getAdapter } from "./adapters"
import type { AdapterCallbacks } from "./adapters/types"
import type { EventBus } from "./event-bus"
import type { SessionMonitorBridge } from "./bridge"
import type { NotificationService } from "./notifications"
import type { Persistence, PersistedState } from "./persistence"
import { buildDemoState } from "./demo-seed"
import { realpathSync, statSync } from "node:fs"
import type { PermissionMode } from "@shared/permission"
import { DEFAULT_PERMISSION_MODE } from "@shared/permission"
import type { SettingsStore } from "./settings"

const MAX_MESSAGES_PER_SESSION = 200

export class SessionManager {
  private sessions = new Map<string, SessionMeta>()
  private messages = new Map<string, ChatMessage[]>()
  private activeSessionId: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private started = false

  constructor(
    private readonly bus: EventBus,
    private readonly persistence: Persistence,
    private readonly bridge: SessionMonitorBridge,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsStore,
  ) {}

  getPermissionMode(): PermissionMode {
    return this.settings.permissionMode
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionMode> {
    const next = await this.settings.setPermissionMode(mode)
    return next.permissionMode
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
  }

  getSnapshot(): SessionSnapshot {
    const messages: Record<string, ChatMessage[]> = {}
    for (const [id, msgs] of this.messages) {
      messages[id] = msgs
    }
    return {
      sessions: this.listSessions(),
      messages,
      activeSessionId: this.activeSessionId,
    }
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
    // Ensure renderer has messages for the focused session.
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
    const adapter = getAdapter(input.provider)
    if (!adapter.available) {
      throw new Error(
        `Provider "${input.provider}" is not available. Install the CLI or pick another agent.`,
      )
    }

    const now = Date.now()
    const id = randomUUID()
    const cwd = resolveSessionCwd(input.cwd)
    const project = normalizeProject(input.project, cwd)
    const cfg = this.settings.getProviderConfig(input.provider)
    const model =
      input.model?.trim() || cfg.defaultModel || undefined
    const session: SessionMeta = {
      id,
      title: input.title?.trim() || defaultTitle(input.provider, project, now),
      project,
      provider: input.provider,
      model,
      cwd,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    }

    this.sessions.set(id, session)
    this.messages.set(id, [])
    this.activeSessionId = id

    const cb = this.callbacks()
    await adapter.start(
      { sessionId: id, cwd: session.cwd, title: session.title },
      cb,
    )

    this.publishSessionEvent({ type: "session.upsert", session })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.bus.emit({
      type: "messages.replaced",
      sessionId: id,
      messages: [],
    })
    this.scheduleSave()
    return session
  }

  async sendMessage(
    sessionId: string,
    text: string,
    opts?: {
      effort?: import("./adapters/types").EffortLevel
      attachments?: string[]
    },
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")

    const content = text.trim()
    if (!content && !opts?.attachments?.length) return

    const attachNote =
      opts?.attachments && opts.attachments.length > 0
        ? `\n\n[attached: ${opts.attachments.map((p) => p.split("/").pop()).join(", ")}]`
        : ""
    const userContent = (content || "(attachments)") + attachNote

    const userMsg: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: "user",
      content: userContent,
      createdAt: Date.now(),
    }
    this.appendMessage(userMsg)
    this.touch(sessionId)
    this.publishSessionEvent({
      type: "session.message",
      id: sessionId,
      role: "user",
      preview: userContent.slice(0, 160),
    })

    const adapter = getAdapter(session.provider)
    const permissionMode =
      this.settings.permissionMode || DEFAULT_PERMISSION_MODE
    // Fire-and-forget: stream/status arrive via event bus; UI stays responsive.
    void adapter
      .send(sessionId, content || "Please review the attached files.", this.callbacks(), {
        permissionMode,
        model: session.model,
        effort: opts?.effort,
        attachments: opts?.attachments,
      })
      .then(() => {
        if (this.sessions.get(sessionId)?.status === "running") {
          this.applyStatus(sessionId, "idle")
        }
      })
      .catch((err) => {
        console.error("[session-manager] send failed", err)
        this.applyStatus(sessionId, "error")
        this.publishSessionEvent({
          type: "session.ended",
          id: sessionId,
          reason: "error",
        })
      })
  }

  async abortSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await getAdapter(session.provider).abort(sessionId)
    this.applyStatus(sessionId, "idle")
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    try {
      await getAdapter(session.provider).dispose(sessionId)
    } catch {
      // ignore dispose errors
    }

    this.sessions.delete(sessionId)
    this.messages.delete(sessionId)
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
        this.appendMessage(message)
        this.touch(message.sessionId)
        this.scheduleSave()
      },
      onDelta: (sessionId, messageId, delta) => {
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
        const list = this.messages.get(sessionId)
        if (list) {
          const idx = list.findIndex((m) => m.id === messageId)
          if (idx !== -1) {
            list[idx] = { ...list[idx], streaming: false }
          }
        }
        this.bus.emit({ type: "chat.done", sessionId, messageId })
        this.scheduleSave()
      },
    }
  }

  private applyStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.status === status) {
      this.publishSessionEvent({ type: "session.status", id, status })
      return
    }
    const next = { ...session, status, updatedAt: Date.now() }
    this.sessions.set(id, next)
    this.publishSessionEvent({ type: "session.status", id, status })
    this.bus.emit({ type: "sessions.replaced", sessions: this.listSessions() })
    this.scheduleSave()
  }

  private appendMessage(message: ChatMessage): void {
    const list = this.messages.get(message.sessionId) ?? []
    list.push(message)
    while (list.length > MAX_MESSAGES_PER_SESSION) list.shift()
    this.messages.set(message.sessionId, list)
    this.bus.emit({ type: "chat.message", message })
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
    this.bridge.publish(event)
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
    return {
      version: 1,
      sessions: this.listSessions(),
      messages,
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
  const raw = input?.trim() || process.cwd()
  try {
    const real = realpathSync(raw)
    if (!statSync(real).isDirectory()) {
      throw new Error(`Not a directory: ${raw}`)
    }
    return real
  } catch (err) {
    throw new Error(
      `Invalid project folder: ${raw} (${err instanceof Error ? err.message : String(err)})`,
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
