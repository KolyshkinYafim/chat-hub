
export function nextWindowId(taken: Iterable<number>): number {
  const used = new Set(taken)
  let id = 1
  while (used.has(id)) id += 1
  return id
}

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

export class WindowRegistry<T> {
  private readonly entries = new Map<number, T>()
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

  touch(id: number): void {
    if (!this.entries.has(id)) return
    this.order = [...this.order.filter((other) => other !== id), id]
  }

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
