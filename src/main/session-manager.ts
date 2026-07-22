import { randomUUID } from "node:crypto"
import type {
  ChatMessage,
  CreateSessionInput,
  ProviderId,
  SessionMeta,
  SessionSnapshot,
  SessionStatus,
} from "@shared/types"
import { getAdapter } from "./adapters"
import type { AdapterCallbacks } from "./adapters/types"
import type { EventBus } from "./event-bus"
import type { SessionMonitorBridge } from "./bridge"
import type { NotificationService } from "./notifications"
import type { Persistence, PersistedState } from "./persistence"

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
  ) {}

  async init(): Promise<void> {
    if (this.started) return
    this.started = true

    const state = await this.persistence.load()
    for (const session of state.sessions) {
      // Never restore as stuck running without a live process.
      const status: SessionStatus =
        session.status === "running" ? "idle" : session.status
      this.sessions.set(session.id, { ...session, status })
    }
    for (const [id, msgs] of Object.entries(state.messages)) {
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

  setActiveSession(id: string | null): void {
    if (id && !this.sessions.has(id)) return
    this.activeSessionId = id
    this.scheduleSave()
  }

  async createSession(input: CreateSessionInput): Promise<SessionMeta> {
    const adapter = getAdapter(input.provider)
    if (!adapter.available) {
      throw new Error(`Provider "${input.provider}" is not available yet`)
    }

    const now = Date.now()
    const id = randomUUID()
    const session: SessionMeta = {
      id,
      title: input.title?.trim() || defaultTitle(input.provider, now),
      provider: input.provider,
      cwd: input.cwd?.trim() || process.cwd(),
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

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error("Session not found")

    const content = text.trim()
    if (!content) return

    const userMsg: ChatMessage = {
      id: randomUUID(),
      sessionId,
      role: "user",
      content,
      createdAt: Date.now(),
    }
    this.appendMessage(userMsg)
    this.touch(sessionId)
    this.publishSessionEvent({
      type: "session.message",
      id: sessionId,
      role: "user",
      preview: content.slice(0, 160),
    })

    const adapter = getAdapter(session.provider)
    try {
      await adapter.send(sessionId, content, this.callbacks())
    } catch (err) {
      this.applyStatus(sessionId, "error")
      this.publishSessionEvent({
        type: "session.ended",
        id: sessionId,
        reason: "error",
      })
      throw err
    }
    // Adapters must clear running via events; force idle if they forget.
    if (this.sessions.get(sessionId)?.status === "running") {
      this.applyStatus(sessionId, "idle")
    }
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

function defaultTitle(provider: ProviderId, now: number): string {
  const t = new Date(now)
  const hh = String(t.getHours()).padStart(2, "0")
  const mm = String(t.getMinutes()).padStart(2, "0")
  return `${provider} · ${hh}:${mm}`
}
