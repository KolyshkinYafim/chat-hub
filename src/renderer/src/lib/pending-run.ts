type PendingListener = (sessionId: string) => void

type Handoff = {
  stash: (sessionId: string, value: string) => void
  peek: (sessionId: string) => string | null
  take: (sessionId: string) => string | null
  clear: (sessionId: string) => void
  subscribe: (cb: PendingListener) => () => void
  prune: (liveSessionIds: ReadonlySet<string>) => void
}

/**
 * One value in flight from a click to the surface that will act on it. The
 * surface may not be mounted when the click happens (the dock shows one at a
 * time), so the value waits here and the listener wakes whichever surface is
 * already up.
 */
function createHandoff(): Handoff {
  const values = new Map<string, string>()
  const listeners = new Set<PendingListener>()

  return {
    stash(sessionId, value) {
      values.set(sessionId, value)
      for (const listener of [...listeners]) listener(sessionId)
    },
    peek(sessionId) {
      return values.get(sessionId) ?? null
    },
    take(sessionId) {
      const value = values.get(sessionId) ?? null
      values.delete(sessionId)
      return value
    },
    clear(sessionId) {
      values.delete(sessionId)
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    prune(liveSessionIds) {
      for (const sessionId of [...values.keys()]) {
        if (!liveSessionIds.has(sessionId)) values.delete(sessionId)
      }
    },
  }
}

const terminal = createHandoff()
const browser = createHandoff()

/** Hand a script command to the session's terminal surface (mounted or not). */
export function stashTerminalCommand(sessionId: string, command: string): void {
  terminal.stash(sessionId, command)
}

export function takeTerminalCommand(sessionId: string): string | null {
  return terminal.take(sessionId)
}

export function onPendingTerminalCommand(cb: PendingListener): () => void {
  return terminal.subscribe(cb)
}

/** Hand a preview URL to the session's browser surface (mounted or not). */
export function stashBrowserUrl(sessionId: string, url: string): void {
  browser.stash(sessionId, url)
}

/**
 * Non-destructive on purpose: the browser surface peeks during render (twice
 * under StrictMode) and clears from an effect once the URL has been applied.
 */
export function peekBrowserUrl(sessionId: string): string | null {
  return browser.peek(sessionId)
}

export function clearBrowserUrl(sessionId: string): void {
  browser.clear(sessionId)
}

export function onPendingBrowserUrl(cb: PendingListener): () => void {
  return browser.subscribe(cb)
}

export function prunePendingRuns(liveSessionIds: ReadonlySet<string>): void {
  terminal.prune(liveSessionIds)
  browser.prune(liveSessionIds)
}
