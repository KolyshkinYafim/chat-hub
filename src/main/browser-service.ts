import type { BrowserRequest, BrowserResponse } from "@shared/browser"
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
}

const DEFAULT_OPEN_WAIT_MS = 4000

const NO_SURFACE =
  "Chat Hub could not open a browser surface for this session. Open the Browser surface in the right-hand panel and retry."

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
