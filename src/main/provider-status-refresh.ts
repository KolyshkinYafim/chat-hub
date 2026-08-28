import type {
  ProviderStatus,
  ProviderStatusCache,
} from "@shared/settings-types"

export const PROVIDER_STATUS_TTL_MS = 60_000

export type ProviderStatusCacheLike = {
  readonly current: ProviderStatusCache | null
  set(cache: ProviderStatusCache): Promise<void>
}

type Inflight = {
  key: string
  generation: number
  promise: Promise<ProviderStatus[]>
}

export class ProviderStatusRefresher {
  private generation = 0
  private inflight: Inflight | null = null

  constructor(
    private readonly opts: {
      probe: () => Promise<ProviderStatus[]>
      configKey: () => string
      cache: ProviderStatusCacheLike
      emit: (statuses: ProviderStatus[], cachedAt: number) => void
      ttlMs?: number
      now?: () => number
    },
  ) {}

  get cached(): ProviderStatusCache | null {
    return this.opts.cache.current
  }

  refresh(): Promise<ProviderStatus[]> {
    const key = this.opts.configKey()
    if (this.inflight && this.inflight.key === key) {
      return this.inflight.promise
    }
    const generation = ++this.generation
    const run: Inflight = { key, generation, promise: Promise.resolve([]) }
    const settle = () => {
      if (this.inflight === run) this.inflight = null
    }
    run.promise = this.opts.probe().then(
      async (statuses) => {
        settle()
        if (generation !== this.generation) return statuses
        const cachedAt = this.now()
        try {
          await this.opts.cache.set({ statuses, cachedAt })
        } catch (err) {
          console.error("[providers] status cache save failed", err)
        }
        if (generation !== this.generation) return statuses
        this.opts.emit(statuses, cachedAt)
        return statuses
      },
      (err: unknown) => {
        settle()
        throw err
      },
    )
    this.inflight = run
    return run.promise
  }

  kickIfStale(): void {
    if (this.inflight) return
    const cached = this.opts.cache.current
    const ttl = this.opts.ttlMs ?? PROVIDER_STATUS_TTL_MS
    if (cached && this.now() - cached.cachedAt < ttl) return
    void this.refresh().catch((err) =>
      console.error("[providers] status refresh failed", err),
    )
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }
}
