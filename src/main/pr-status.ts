import type { GitPrStatus } from "@shared/types"

export const PR_POLL_INTERVAL_MS = 60_000

type Options = {
  fetch: (cwd: string) => Promise<GitPrStatus>
  liveCwds: () => string[]
  emit: (cwd: string, status: GitPrStatus) => void
  intervalMs?: number
}

export class PrStatusWatcher {
  private readonly cache = new Map<string, GitPrStatus>()
  private readonly inflight = new Map<string, Promise<GitPrStatus>>()
  private timer: NodeJS.Timeout | null = null
  private ghMissing = false

  constructor(private readonly opts: Options) {}

  snapshot(): Record<string, GitPrStatus> {
    return Object.fromEntries(this.cache)
  }

  refresh(cwd: string): Promise<GitPrStatus> {
    const running = this.inflight.get(cwd)
    if (running) return running
    const run = this.opts.fetch(cwd).then(
      (status) => {
        this.inflight.delete(cwd)
        this.ghMissing = status.unavailable === "missing"
        this.cache.set(cwd, status)
        this.opts.emit(cwd, status)
        return status
      },
      (err: unknown) => {
        this.inflight.delete(cwd)
        throw err
      },
    )
    this.inflight.set(cwd, run)
    return run
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(
      () => void this.tick(),
      this.opts.intervalMs ?? PR_POLL_INTERVAL_MS,
    )
    void this.tick()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    const live = new Set(this.opts.liveCwds())
    for (const cwd of [...this.cache.keys()]) {
      if (!live.has(cwd)) this.cache.delete(cwd)
    }
    if (this.ghMissing) return
    for (const cwd of live) {
      if (this.ghMissing) return
      await this.refresh(cwd).catch(() => undefined)
    }
  }
}
