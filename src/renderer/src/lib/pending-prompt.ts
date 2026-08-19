type PendingListener = (sessionId: string) => void

const inserts = new Map<string, string>()
const listeners = new Set<PendingListener>()

/** Hand text to the session's composer draft (mounted or not); never auto-sends. */
export function stashComposerInsert(sessionId: string, text: string): void {
  const existing = inserts.get(sessionId)
  inserts.set(sessionId, existing ? `${existing}\n\n${text}` : text)
  for (const listener of [...listeners]) listener(sessionId)
}

export function takeComposerInsert(sessionId: string): string | null {
  const text = inserts.get(sessionId) ?? null
  inserts.delete(sessionId)
  return text
}

export function onPendingComposerInsert(cb: PendingListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function prunePendingPrompts(liveSessionIds: ReadonlySet<string>): void {
  for (const sessionId of [...inserts.keys()]) {
    if (!liveSessionIds.has(sessionId)) inserts.delete(sessionId)
  }
}
