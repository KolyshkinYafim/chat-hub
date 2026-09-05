import type { GitPrStatus } from "@shared/types"

export const PR_POLL_INTERVAL_MS = 60_000

type Options = {
  fetch: (cwd: string) => Promise<GitPrStatus>
  liveCwds: () => string[]
  emit: (cwd: string, status: GitPrStatus) => void
  intervalMs?: number
}

export function failingSignature(status: GitPrStatus): string | null {
  const pr = status.pr
  if (!pr) return null
  const failing = pr.checks
    .filter((check) => check.state === "failure")
    .map((check) => check.name)
    .sort()
  return failing.length === 0 ? null : `${pr.number}:${failing.join("\u0000")}`
}

export class PrStatusWatcher {
  private readonly cache = new Map<string, GitPrStatus>()
  private readonly inflight = new Map<string, Promise<GitPrStatus>>()
  private readonly acknowledged = new Map<string, string>()
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
      (fetched) => {
        this.inflight.delete(cwd)
        this.ghMissing = fetched.unavailable === "missing"
        const status = this.withAcknowledgement(cwd, fetched)
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

  acknowledge(cwd: string): GitPrStatus | null {
    const current = this.cache.get(cwd)
    const signature = current ? failingSignature(current) : null
    if (!current || signature === null) return current ?? null
    this.acknowledged.set(cwd, signature)
    const status: GitPrStatus = { ...current, acknowledged: true }
    this.cache.set(cwd, status)
    this.opts.emit(cwd, status)
    return status
  }

  private withAcknowledgement(cwd: string, status: GitPrStatus): GitPrStatus {
    const signature = failingSignature(status)
    if (signature === null) {
      this.acknowledged.delete(cwd)
      return status
    }
    if (this.acknowledged.get(cwd) === signature) {
      return { ...status, acknowledged: true }
    }
    this.acknowledged.delete(cwd)
    return status
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
      if (live.has(cwd)) continue
      this.cache.delete(cwd)
      this.acknowledged.delete(cwd)
    }
    if (this.ghMissing) return
    for (const cwd of live) {
      if (this.ghMissing) return
      await this.refresh(cwd).catch(() => undefined)
    }
  }
}
