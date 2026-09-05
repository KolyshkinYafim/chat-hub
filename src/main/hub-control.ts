import { quote } from "./surfaces/surface-control"
import {
  HUB_CONTROL_DISABLED_MESSAGE,
  HUB_OPS,
  arrangePanes,
  arrangeSessionFor,
  frontWindow,
  parseHubPanes,
  parseHubPreset,
  parseHubSessionId,
  parseHubSurfaceChoice,
  parseHubWindowId,
  surfaceForChoice,
  type HubLayoutCommand,
  type HubParse,
  type HubPreset,
  type HubRequest,
  type HubResponse,
  type HubWindowSnapshot,
} from "@shared/hub-control"
import { SURFACE_LABEL, type SurfaceKind } from "@shared/surfaces"

export type HubControlSession = { id: string; title: string }

export type HubControlDeps = {
  enabled: () => boolean
  windows: () => HubWindowSnapshot[]
  recency: () => number[]
  session: (sessionId: string) => HubControlSession | null
  activeSessionId: () => string | null
  openWindow: (sessionId: string | null) => number
  focusSession: (sessionId: string, windowId: number | null) => number
  applyLayout: (command: HubLayoutCommand) => void
  openSurface: (
    request: HubRequest,
    surface: SurfaceKind,
  ) => Promise<HubResponse>
}

const NO_WINDOWS_MESSAGE =
  "Chat Hub has no open windows. Use hub_open_window first."

const NO_ARRANGE_SESSION_MESSAGE =
  "No session is on screen to arrange around. Use hub_focus_session or hub_open_window with a sessionId first."

export class HubControl {
  constructor(private readonly deps: HubControlDeps) {}

  async handle(request: HubRequest): Promise<HubResponse> {
    if (!this.deps.enabled()) {
      return { id: request.id, ok: false, error: HUB_CONTROL_DISABLED_MESSAGE }
    }
    return this.handleTrusted(request)
  }

  async handleTrusted(request: HubRequest): Promise<HubResponse> {
    try {
      return await this.run(request)
    } catch (err) {
      return {
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private run(request: HubRequest): Promise<HubResponse> {
    const params = request.params ?? {}
    switch (request.op) {
      case HUB_OPS.listWindows:
        return Promise.resolve(this.listWindows(request))
      case HUB_OPS.openWindow:
        return Promise.resolve(this.openWindow(request, params))
      case HUB_OPS.focusSession:
        return Promise.resolve(this.focusSession(request, params))
      case HUB_OPS.setLayout:
        return Promise.resolve(this.setLayout(request, params))
      case HUB_OPS.openSurface:
        return this.openSurface(request, params)
      case HUB_OPS.arrange:
        return Promise.resolve(this.arrange(request, params))
      default:
        throw new Error(`Unknown hub operation ${quote(request.op)}.`)
    }
  }

  private ok(id: string, summary: string, extra: Record<string, unknown> = {}): HubResponse {
    return { id, ok: true, result: { summary, ...extra } }
  }

  private unwrap<T>(parsed: HubParse<T>): T {
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.value
  }

  private requireSession(sessionId: string): HubControlSession {
    const session = this.deps.session(sessionId)
    if (!session) {
      throw new Error(
        `No Chat Hub session has the id ${quote(sessionId)}. List sessions with hub_list_windows or ask the user.`,
      )
    }
    return session
  }

  private requireWindow(windowId: number): HubWindowSnapshot {
    const match = this.deps.windows().find((w) => w.id === windowId)
    if (!match) {
      throw new Error(
        `No Chat Hub window has the id ${windowId}. Read the open windows with hub_list_windows.`,
      )
    }
    return match
  }

  private sessionLine(sessionId: string): string {
    const session = this.deps.session(sessionId)
    return session ? `${quote(session.title)} (${session.id})` : sessionId
  }

  private listWindows(request: HubRequest): HubResponse {
    const windows = this.deps.windows()
    if (windows.length === 0) {
      return this.ok(request.id, NO_WINDOWS_MESSAGE, { windows: [] })
    }
    const lines = windows.map((w) => {
      const marker = w.focused ? " (focused)" : ""
      const shown =
        w.sessionIds.length === 0
          ? "no sessions"
          : w.sessionIds.map((id) => this.sessionLine(id)).join(", ")
      return `Window ${w.id}${marker} — ${shown}`
    })
    const rows = windows.map((w) => ({
      id: w.id,
      focused: w.focused,
      sessions: w.sessionIds.map((id) => ({
        id,
        title: this.deps.session(id)?.title ?? null,
      })),
    }))
    return this.ok(request.id, lines.join("\n"), { windows: rows })
  }

  private openWindow(
    request: HubRequest,
    params: Record<string, unknown>,
  ): HubResponse {
    const raw = params.sessionId
    const seed =
      raw === undefined || raw === null || raw === ""
        ? null
        : this.requireSession(this.unwrap(parseHubSessionId(raw))).id
    const windowId = this.deps.openWindow(seed)
    return this.ok(
      request.id,
      seed
        ? `Opened window ${windowId} showing ${this.sessionLine(seed)}.`
        : `Opened window ${windowId} with an empty pane.`,
      { windowId },
    )
  }

  private focusSession(
    request: HubRequest,
    params: Record<string, unknown>,
  ): HubResponse {
    const sessionId = this.unwrap(parseHubSessionId(params.sessionId))
    const windowId = this.unwrap(parseHubWindowId(params.windowId, { required: false }))
    const session = this.requireSession(sessionId)
    if (windowId !== null) this.requireWindow(windowId)
    const landed = this.deps.focusSession(session.id, windowId)
    return this.ok(
      request.id,
      `Focused ${this.sessionLine(session.id)} in window ${landed}.`,
      { windowId: landed },
    )
  }

  private setLayout(
    request: HubRequest,
    params: Record<string, unknown>,
  ): HubResponse {
    const windowId = this.unwrap(parseHubWindowId(params.windowId, { required: true })) as number
    const sessionIds = this.unwrap(parseHubPanes(params.panes))
    this.requireWindow(windowId)
    for (const sessionId of sessionIds) this.requireSession(sessionId)
    this.deps.applyLayout({
      windowId,
      panes: sessionIds.map((sessionId) => ({
        sessionId,
        dockOpen: null,
        surface: null,
      })),
      focusSessionId: sessionIds[0] ?? null,
      at: Date.now(),
    })
    const shown = sessionIds.map((id) => this.sessionLine(id)).join(", ")
    return this.ok(
      request.id,
      `Window ${windowId} now shows ${sessionIds.length} pane${sessionIds.length === 1 ? "" : "s"}, left to right: ${shown}.`,
      { windowId },
    )
  }

  private async openSurface(
    request: HubRequest,
    params: Record<string, unknown>,
  ): Promise<HubResponse> {
    const sessionId = this.unwrap(parseHubSessionId(params.sessionId))
    const choice = this.unwrap(parseHubSurfaceChoice(params.surface))
    this.requireSession(sessionId)
    const surface = surfaceForChoice(choice)
    return this.deps.openSurface(
      { ...request, sessionId, params: { surface } },
      surface,
    )
  }

  private arrange(
    request: HubRequest,
    params: Record<string, unknown>,
  ): HubResponse {
    const preset = this.unwrap(parseHubPreset(params.preset))
    const front = frontWindow(this.deps.windows(), this.deps.recency())
    const sessionId = arrangeSessionFor(front, this.deps.activeSessionId())
    if (!sessionId || !this.deps.session(sessionId)) {
      throw new Error(NO_ARRANGE_SESSION_MESSAGE)
    }
    const windowId = front ? front.id : this.deps.openWindow(sessionId)
    this.deps.applyLayout({
      windowId,
      panes: arrangePanes(preset, sessionId),
      focusSessionId: sessionId,
      at: Date.now(),
    })
    return this.ok(request.id, this.arrangeSummary(preset, windowId, sessionId), {
      windowId,
    })
  }

  private arrangeSummary(
    preset: HubPreset,
    windowId: number,
    sessionId: string,
  ): string {
    const who = this.sessionLine(sessionId)
    switch (preset) {
      case "review":
        return `Arranged window ${windowId} for review: ${who} with the ${SURFACE_LABEL.diff} panel open.`
      case "monitor":
        return `Arranged window ${windowId} as a monitor: ${who} with the ${SURFACE_LABEL.fleet} overview open.`
      case "deep-work":
        return `Arranged window ${windowId} for deep work: ${who} solo, panels closed.`
    }
  }
}
