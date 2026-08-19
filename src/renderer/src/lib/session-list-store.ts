type Identified = { id: string }

export type SessionListStore<T extends Identified> = {
  add: (sessionId: string, input: Omit<T, "id">) => T
  update: (sessionId: string, id: string, patch: Partial<Omit<T, "id">>) => void
  remove: (sessionId: string, id: string) => void
  list: (sessionId: string) => T[]
  clear: (sessionId: string) => void
  subscribe: (cb: () => void) => () => void
  prune: (liveSessionIds: ReadonlySet<string>) => void
}

/**
 * Renderer-side draft items a session accumulates before they are sent as one
 * message (diff comments, page picks). Deliberately outside React state: the
 * surfaces that collect them unmount whenever the dock switches, and a draft
 * must outlive that. Sessions the main process no longer knows are pruned.
 */
export function createSessionListStore<T extends Identified>(
  idPrefix: string,
): SessionListStore<T> {
  const store = new Map<string, T[]>()
  const listeners = new Set<() => void>()
  let nextId = 0

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const replace = (sessionId: string, items: T[]): void => {
    if (items.length === 0) store.delete(sessionId)
    else store.set(sessionId, items)
    notify()
  }

  return {
    add(sessionId, input) {
      nextId += 1
      const item = { id: `${idPrefix}-${nextId}`, ...input } as T
      store.set(sessionId, [...(store.get(sessionId) ?? []), item])
      notify()
      return item
    },
    update(sessionId, id, patch) {
      const existing = store.get(sessionId)
      if (!existing?.some((item) => item.id === id)) return
      replace(
        sessionId,
        existing.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      )
    },
    remove(sessionId, id) {
      const existing = store.get(sessionId)
      if (!existing?.some((item) => item.id === id)) return
      replace(
        sessionId,
        existing.filter((item) => item.id !== id),
      )
    },
    list(sessionId) {
      return [...(store.get(sessionId) ?? [])]
    },
    clear(sessionId) {
      if (!store.has(sessionId)) return
      store.delete(sessionId)
      notify()
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    prune(liveSessionIds) {
      for (const sessionId of [...store.keys()]) {
        if (!liveSessionIds.has(sessionId)) store.delete(sessionId)
      }
    },
  }
}
