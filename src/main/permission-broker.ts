import type {
  AgentInputRequestInfo,
  PermissionDecider,
  PermissionDecision,
  PermissionRequestInfo,
} from "@shared/types"
import { agentDesktopSocketPath, chatHubSocketPath } from "@shared/bridge-path"
import {
  HubPermissionServer,
  mirrorToIsland,
  type IncomingRequest,
  type RawPermissionRequest,
} from "./permission-socket"
import type { EventBus } from "./event-bus"

/**
 * One approval surface, two windows.
 *
 * A Hub-spawned CLI runs the same hook as a terminal one, pointed at the Hub's
 * socket instead of the island's (see session-manager's AGENT_DESKTOP_SOCKET).
 * The Hub renders the request in the transcript AND mirrors it onto the island
 * byte-for-byte, so whichever surface the user is looking at can answer. First
 * decision wins; the loser's card is withdrawn.
 *
 * The mirror is deliberately verbatim — the island already de-dupes the hook's
 * own JSONL `session.permission` line against the socket request by requestId,
 * and rewriting either id would give it two cards for one tool call.
 */

/** A hook waiting longer than its own socket timeout is answering nobody. */
const PENDING_TTL_MS = 12 * 3_600_000
const REAP_INTERVAL_MS = 300_000

type Pending = {
  info: PermissionRequestInfo
  answer: (behavior: PermissionDecision) => void
  dismiss: () => void
  cancelMirror: () => void
}

type PendingInput = {
  info: AgentInputRequestInfo
  answer: (answers: Record<string, string[]>) => void
}

export type SessionLookup = (
  agentSessionId: string,
  cwd: string | undefined,
) => string | null

export class PermissionBroker {
  private readonly server: HubPermissionServer
  private pending = new Map<string, Pending>()
  private pendingInputs = new Map<string, PendingInput>()
  private reaper: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly bus: EventBus,
    private readonly lookupSession: SessionLookup,
    private readonly islandPath = agentDesktopSocketPath(),
    socketPath = chatHubSocketPath(),
  ) {
    this.server = new HubPermissionServer(socketPath, (req) =>
      this.accept(req),
    )
  }

  /** Path handed to spawned CLIs; null while the socket is not up. */
  get socketPath(): string | null {
    return this.server.listening ? this.server.path : null
  }

  async start(): Promise<void> {
    try {
      await this.server.start()
    } catch (err) {
      // No socket means Hub sessions keep the island-only behaviour they have
      // today — worth a log, never worth failing app start.
      console.error("[permissions] socket unavailable", err)
      return
    }
    this.reaper = setInterval(() => this.reapStale(), REAP_INTERVAL_MS)
    this.reaper.unref?.()
  }

  async stop(): Promise<void> {
    if (this.reaper) {
      clearInterval(this.reaper)
      this.reaper = null
    }
    for (const requestId of [...this.pending.keys()]) {
      this.forget(requestId, "gone")
    }
    for (const item of this.pendingInputs.values()) item.answer({})
    this.pendingInputs.clear()
    await this.server.stop()
  }

  list(): PermissionRequestInfo[] {
    return [...this.pending.values()].map((p) => p.info)
  }

  listInputs(): AgentInputRequestInfo[] {
    return [...this.pendingInputs.values()].map((item) => item.info)
  }

  /** Answer from the Hub transcript. False when the request is already gone. */
  resolve(requestId: string, behavior: PermissionDecision): boolean {
    const item = this.pending.get(requestId)
    if (!item) return false
    this.pending.delete(requestId)
    // Hanging up first: the island's EOF path withdraws its own card, which is
    // the only way it learns the Hub answered.
    item.cancelMirror()
    item.answer(behavior)
    this.emitResolved(item.info, behavior, "hub")
    return true
  }

  /** Register a native app-server approval (no hook socket is involved). */
  requestFromAdapter(
    request: Omit<PermissionRequestInfo, "createdAt">,
  ): Promise<PermissionDecision> {
    const previous = this.pending.get(request.requestId)
    if (previous) previous.dismiss()
    const info: PermissionRequestInfo = { ...request, createdAt: Date.now() }
    return new Promise((resolve) => {
      let settled = false
      const settle = (decision: PermissionDecision): void => {
        if (settled) return
        settled = true
        resolve(decision)
      }
      this.pending.set(info.requestId, {
        info,
        answer: settle,
        dismiss: () => settle("deny"),
        cancelMirror: () => undefined,
      })
      this.bus.emit({ type: "permission.request", request: info })
    })
  }

  requestInputFromAdapter(
    request: Omit<AgentInputRequestInfo, "createdAt">,
  ): Promise<Record<string, string[]>> {
    const info: AgentInputRequestInfo = { ...request, createdAt: Date.now() }
    return new Promise((resolve) => {
      this.pendingInputs.set(info.requestId, { info, answer: resolve })
      this.bus.emit({ type: "input.request", request: info })
    })
  }

  resolveInput(requestId: string, answers: Record<string, string[]>): boolean {
    const pending = this.pendingInputs.get(requestId)
    if (!pending) return false
    this.pendingInputs.delete(requestId)
    pending.answer(answers)
    this.bus.emit({
      type: "input.resolved",
      requestId,
      sessionId: pending.info.sessionId,
    })
    return true
  }

  resolveExternally(requestIds: string[]): void {
    for (const requestId of requestIds) {
      const permission = this.pending.get(requestId)
      if (permission) {
        this.pending.delete(requestId)
        permission.dismiss()
        this.emitResolved(permission.info, "cancelled", "gone")
      }
      const input = this.pendingInputs.get(requestId)
      if (input) {
        this.pendingInputs.delete(requestId)
        input.answer({})
        this.bus.emit({ type: "input.resolved", requestId, sessionId: input.info.sessionId })
      }
    }
  }

  /** Withdraw every request of a session that is being killed. */
  cancelForSession(sessionId: string): void {
    for (const [requestId, item] of this.pending) {
      if (item.info.sessionId === sessionId) this.forget(requestId, "gone")
    }
    for (const [requestId, item] of this.pendingInputs) {
      if (item.info.sessionId !== sessionId) continue
      this.pendingInputs.delete(requestId)
      item.answer({})
      this.bus.emit({ type: "input.resolved", requestId, sessionId })
    }
  }

  private accept(req: IncomingRequest): void {
    const raw = req.raw
    const agentSessionId =
      typeof raw.sessionId === "string" && raw.sessionId
        ? raw.sessionId
        : "unknown"
    const payload = raw.payload ?? {}
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined
    const requestId =
      typeof raw.requestId === "string" && raw.requestId
        ? raw.requestId
        : `${agentSessionId}-perm-${Date.now()}`

    const info: PermissionRequestInfo = {
      requestId,
      sessionId: this.lookupSession(agentSessionId, cwd),
      agentSessionId,
      source: typeof raw.source === "string" ? raw.source : "claude",
      summary:
        typeof raw.summary === "string" && raw.summary
          ? raw.summary
          : "Needs permission",
      toolName:
        typeof payload.tool_name === "string" ? payload.tool_name : undefined,
      cwd,
      createdAt: Date.now(),
    }

    const mirror = mirrorToIsland(this.islandPath, raw as RawPermissionRequest)
    this.pending.set(requestId, {
      info,
      answer: req.answer,
      dismiss: req.dismiss,
      cancelMirror: mirror.cancel,
    })
    req.onGone(() => this.forget(requestId, "gone"))

    void mirror.decision.then((behavior) => {
      if (!behavior) return
      const item = this.pending.get(requestId)
      if (!item) return
      this.pending.delete(requestId)
      item.answer(behavior)
      this.emitResolved(item.info, behavior, "island")
    })

    this.bus.emit({ type: "permission.request", request: info })
  }

  /** Drop a request nobody can answer any more and tell the renderer why. */
  private forget(requestId: string, decidedBy: PermissionDecider): void {
    const item = this.pending.get(requestId)
    if (!item) return
    this.pending.delete(requestId)
    item.cancelMirror()
    item.dismiss()
    this.emitResolved(item.info, "cancelled", decidedBy)
  }

  private reapStale(): void {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [requestId, item] of this.pending) {
      if (item.info.createdAt < cutoff) this.forget(requestId, "expired")
    }
  }

  private emitResolved(
    info: PermissionRequestInfo,
    outcome: PermissionDecision | "cancelled",
    decidedBy: PermissionDecider,
  ): void {
    this.bus.emit({
      type: "permission.resolved",
      requestId: info.requestId,
      sessionId: info.sessionId,
      outcome,
      decidedBy,
    })
  }
}
