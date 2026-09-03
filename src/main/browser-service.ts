import type { BrowserRequest, BrowserResponse } from "@shared/browser"
import { isSurfaceOp, type SurfaceHandler } from "@shared/surface-control"
import {
  isHubOp,
  type HubRequest,
  type HubResponse,
} from "@shared/hub-control"
import { BrowserSocketServer } from "./browser-socket"

export type BrowserExecutor = {
  attach: (sessionId: string, webContentsId: number) => void
  detach: (sessionId: string) => void
  hasGuest: (sessionId: string) => boolean
  handle: (request: BrowserRequest) => Promise<BrowserResponse>
}

export type BrowserServiceDeps = {
  requestOpen: (sessionId: string) => void
  openWaitMs?: number
  /**
   * The `surface.*` half of the socket — opening and reading the rest of the
   * dock. It shares this socket, and therefore this session id, precisely so
   * an agent's panel call is attributed to the session that made it.
   */
  surfaces?: SurfaceHandler
  hub?: (request: HubRequest) => Promise<HubResponse>
}

const DEFAULT_OPEN_WAIT_MS = 4000

const NO_SURFACE =
  "Chat Hub could not open a browser surface for this session. Open the Browser surface in the right-hand panel and retry."

const NO_SURFACE_CONTROL =
  "Chat Hub is not accepting panel commands right now."

const NO_HUB_CONTROL =
  "Chat Hub is not accepting window commands right now."

/**
 * An agent that has never seen the Browser surface should still be able to say
 * "open example.com" and have it work, so a request that arrives with no guest
 * asks the renderer to open the panel and waits for the attach instead of
 * failing and leaving the user to guess what to click.
 */
export class BrowserService {
  private readonly socket: BrowserSocketServer
  private readonly waiters = new Map<string, (() => void)[]>()

  constructor(
    socketPath: string,
    private readonly executor: BrowserExecutor,
    private readonly deps: BrowserServiceDeps,
  ) {
    this.socket = new BrowserSocketServer(socketPath, (request) =>
      this.handle(request),
    )
  }

  get socketPath(): string {
    return this.socket.path
  }

  get listening(): boolean {
    return this.socket.listening
  }

  async start(): Promise<void> {
    await this.socket.start()
  }

  async stop(): Promise<void> {
    for (const [, callbacks] of this.waiters) for (const cb of callbacks) cb()
    this.waiters.clear()
    await this.socket.stop()
  }

  attach(sessionId: string, webContentsId: number): boolean {
    this.executor.attach(sessionId, webContentsId)
    const callbacks = this.waiters.get(sessionId)
    if (callbacks) {
      this.waiters.delete(sessionId)
      for (const cb of callbacks) cb()
    }
    return true
  }

  detach(sessionId: string): boolean {
    this.executor.detach(sessionId)
    return true
  }

  async handle(request: BrowserRequest): Promise<BrowserResponse> {
    // Dock ops never want a webview, so they are routed before the guest check
    // that would otherwise pull the Browser surface open under the user.
    if (isHubOp(request.op)) {
      const hub = this.deps.hub
      if (!hub) {
        return { id: request.id, ok: false, error: NO_HUB_CONTROL }
      }
      return hub(request)
    }
    if (isSurfaceOp(request.op)) {
      const surfaces = this.deps.surfaces
      if (!surfaces) {
        return { id: request.id, ok: false, error: NO_SURFACE_CONTROL }
      }
      return surfaces(request)
    }
    if (!this.executor.hasGuest(request.sessionId)) {
      const opened = await this.openSurface(request.sessionId)
      if (!opened) {
        return { id: request.id, ok: false, error: NO_SURFACE }
      }
    }
    return this.executor.handle(request)
  }

  private openSurface(sessionId: string): Promise<boolean> {
    const wait = this.deps.openWaitMs ?? DEFAULT_OPEN_WAIT_MS
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.dropWaiter(sessionId, finish)
        resolve(this.executor.hasGuest(sessionId))
      }
      const timer = setTimeout(finish, wait)
      timer.unref?.()
      const callbacks = this.waiters.get(sessionId) ?? []
      callbacks.push(finish)
      this.waiters.set(sessionId, callbacks)
      this.deps.requestOpen(sessionId)
    })
  }

  private dropWaiter(sessionId: string, callback: () => void): void {
    const callbacks = this.waiters.get(sessionId)
    if (!callbacks) return
    const rest = callbacks.filter((cb) => cb !== callback)
    if (rest.length === 0) this.waiters.delete(sessionId)
    else this.waiters.set(sessionId, rest)
  }
}
