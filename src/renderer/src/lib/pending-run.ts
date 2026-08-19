type PendingListener = (sessionId: string) => void

const terminalCommands = new Map<string, string>()
const terminalListeners = new Set<PendingListener>()
const browserUrls = new Map<string, string>()
const browserListeners = new Set<PendingListener>()

function notify(listeners: Set<PendingListener>, sessionId: string): void {
  for (const listener of [...listeners]) listener(sessionId)
}

/** Hand a script command to the session's terminal surface (mounted or not). */
export function stashTerminalCommand(sessionId: string, command: string): void {
  terminalCommands.set(sessionId, command)
  notify(terminalListeners, sessionId)
}

export function takeTerminalCommand(sessionId: string): string | null {
  const command = terminalCommands.get(sessionId) ?? null
  terminalCommands.delete(sessionId)
  return command
}

export function onPendingTerminalCommand(cb: PendingListener): () => void {
  terminalListeners.add(cb)
  return () => {
    terminalListeners.delete(cb)
  }
}

/** Hand a preview URL to the session's browser surface (mounted or not). */
export function stashBrowserUrl(sessionId: string, url: string): void {
  browserUrls.set(sessionId, url)
  notify(browserListeners, sessionId)
}

/**
 * Non-destructive on purpose: the browser surface peeks during render (twice
 * under StrictMode) and clears from an effect once the URL has been applied.
 */
export function peekBrowserUrl(sessionId: string): string | null {
  return browserUrls.get(sessionId) ?? null
}

export function clearBrowserUrl(sessionId: string): void {
  browserUrls.delete(sessionId)
}

export function onPendingBrowserUrl(cb: PendingListener): () => void {
  browserListeners.add(cb)
  return () => {
    browserListeners.delete(cb)
  }
}

export function prunePendingRuns(liveSessionIds: ReadonlySet<string>): void {
  for (const sessionId of [...terminalCommands.keys()]) {
    if (!liveSessionIds.has(sessionId)) terminalCommands.delete(sessionId)
  }
  for (const sessionId of [...browserUrls.keys()]) {
    if (!liveSessionIds.has(sessionId)) browserUrls.delete(sessionId)
  }
}
