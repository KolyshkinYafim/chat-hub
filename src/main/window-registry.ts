/**
 * Every open Hub window, and the arithmetic that decides which one a request
 * lands in. Deliberately free of `electron`: the registry holds whatever the
 * caller pairs with an id, so the ordering rules below can be tested without a
 * display server.
 */

/**
 * The smallest id nobody is using. Reuse — rather than an ever-climbing
 * counter — is what lets a closed window come back to its own panes: the
 * layout is stored under the id, and window 1 stays window 1, which is the one
 * still reading the pre-multiwindow storage keys.
 */
export function nextWindowId(taken: Iterable<number>): number {
  const used = new Set(taken)
  let id = 1
  while (used.has(id)) id += 1
  return id
}

/**
 * Which window should answer for a session: the most recently focused one
 * already showing it, so an agent's notification raises the window the user was
 * reading that chat in rather than stealing it into another. With no such
 * window the most recent one wins, and `null` means there is nothing open — the
 * caller has to make a window before it can focus anything.
 */
export function pickWindowForSession(
  sessionId: string | null,
  shows: ReadonlyMap<number, ReadonlySet<string>>,
  recency: readonly number[],
): number | null {
  if (sessionId) {
    for (let i = recency.length - 1; i >= 0; i -= 1) {
      const id = recency[i] as number
      if (shows.get(id)?.has(sessionId)) return id
    }
  }
  return recency.length > 0 ? (recency[recency.length - 1] as number) : null
}

/** Live windows by id, in the order they were last focused. */
export class WindowRegistry<T> {
  private readonly entries = new Map<number, T>()
  /** Least recently focused first; the tail is the window in front. */
  private order: number[] = []

  get size(): number {
    return this.entries.size
  }

  nextId(): number {
    return nextWindowId(this.entries.keys())
  }

  add(id: number, value: T): void {
    this.entries.set(id, value)
    this.order = [...this.order.filter((other) => other !== id), id]
  }

  get(id: number): T | undefined {
    return this.entries.get(id)
  }

  has(id: number): boolean {
    return this.entries.has(id)
  }

  remove(id: number): boolean {
    this.order = this.order.filter((other) => other !== id)
    return this.entries.delete(id)
  }

  /** Mark as the window in front; unknown ids are ignored, not inserted. */
  touch(id: number): void {
    if (!this.entries.has(id)) return
    this.order = [...this.order.filter((other) => other !== id), id]
  }

  /** Ids in recency order, most recent last. */
  recency(): number[] {
    return [...this.order]
  }

  ids(): number[] {
    return [...this.entries.keys()].sort((a, b) => a - b)
  }

  values(): T[] {
    return this.ids().map((id) => this.entries.get(id) as T)
  }

  mostRecentId(): number | null {
    return this.order.length > 0 ? (this.order[this.order.length - 1] as number) : null
  }

  mostRecent(): T | undefined {
    const id = this.mostRecentId()
    return id === null ? undefined : this.entries.get(id)
  }
}
