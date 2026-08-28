import { describe, expect, it, vi } from "vitest"
import type { ProviderStatus, ProviderStatusCache } from "../src/shared/settings-types"
import {
  ProviderStatusRefresher,
  PROVIDER_STATUS_TTL_MS,
} from "../src/main/provider-status-refresh"

function status(id: "claude" | "grok", version: string): ProviderStatus {
  return {
    id,
    instanceId: id,
    homeDir: null,
    isExtra: false,
    label: id,
    installed: true,
    binaryPath: `/usr/local/bin/${id}`,
    version,
    auth: "connected",
    authDetail: "",
    models: [],
    defaultModel: null,
    loginCommand: null,
    docsUrl: null,
    enabled: true,
    envKeys: [],
    envHints: [],
  }
}

type Deferred = {
  promise: Promise<ProviderStatus[]>
  resolve: (statuses: ProviderStatus[]) => void
}

function deferred(): Deferred {
  let resolve!: (statuses: ProviderStatus[]) => void
  const promise = new Promise<ProviderStatus[]>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function harness(opts?: { cachedAt?: number; now?: () => number; ttlMs?: number }) {
  const runs: Deferred[] = []
  const saved: ProviderStatusCache[] = []
  const emitted: { statuses: ProviderStatus[]; cachedAt: number }[] = []
  let current: ProviderStatusCache | null =
    opts?.cachedAt === undefined
      ? null
      : { statuses: [status("claude", "cached")], cachedAt: opts.cachedAt }
  const cache = {
    get current() {
      return current
    },
    set: async (next: ProviderStatusCache) => {
      current = next
      saved.push(next)
    },
  }
  let key = "config-a"
  const refresher = new ProviderStatusRefresher({
    probe: () => {
      const run = deferred()
      runs.push(run)
      return run.promise
    },
    configKey: () => key,
    cache,
    emit: (statuses, cachedAt) => emitted.push({ statuses, cachedAt }),
    ttlMs: opts?.ttlMs,
    now: opts?.now ?? (() => 1_000_000),
  })
  return {
    refresher,
    runs,
    saved,
    emitted,
    setKey: (next: string) => {
      key = next
    },
    cacheNow: () => current,
  }
}

async function drain() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("ProviderStatusRefresher", () => {
  it("a superseded probe never saves the cache or emits", async () => {
    const h = harness()
    const first = h.refresher.refresh()
    h.setKey("config-b")
    const second = h.refresher.refresh()
    expect(h.runs).toHaveLength(2)

    h.runs[1].resolve([status("claude", "new")])
    await second
    expect(h.saved).toHaveLength(1)
    expect(h.emitted).toHaveLength(1)

    h.runs[0].resolve([status("claude", "stale")])
    await first
    await drain()
    expect(h.saved).toHaveLength(1)
    expect(h.emitted).toHaveLength(1)
    expect(h.cacheNow()?.statuses[0].version).toBe("new")
  })

  it("a stale probe finishing after a newer one cannot win even out of order", async () => {
    const h = harness()
    const first = h.refresher.refresh()
    h.setKey("config-b")
    const second = h.refresher.refresh()

    h.runs[0].resolve([status("claude", "stale")])
    await first
    await drain()
    expect(h.saved).toHaveLength(0)
    expect(h.emitted).toHaveLength(0)

    h.runs[1].resolve([status("claude", "new")])
    await second
    expect(h.cacheNow()?.statuses[0].version).toBe("new")
    expect(h.emitted).toHaveLength(1)
  })

  it("coalesces refreshes of the same config into one probe", async () => {
    const h = harness()
    const first = h.refresher.refresh()
    const second = h.refresher.refresh()
    expect(second).toBe(first)
    expect(h.runs).toHaveLength(1)

    h.runs[0].resolve([status("claude", "1")])
    await first
    expect(h.saved).toHaveLength(1)

    const third = h.refresher.refresh()
    expect(third).not.toBe(first)
    expect(h.runs).toHaveLength(2)
    h.runs[1].resolve([status("claude", "2")])
    await third
  })

  it("kickIfStale does nothing while the cache is fresh", async () => {
    const h = harness({ cachedAt: 1_000_000 - 30_000 })
    h.refresher.kickIfStale()
    await drain()
    expect(h.runs).toHaveLength(0)
  })

  it("kickIfStale probes once the cache has aged past the TTL", async () => {
    const h = harness({ cachedAt: 1_000_000 - PROVIDER_STATUS_TTL_MS - 1 })
    h.refresher.kickIfStale()
    expect(h.runs).toHaveLength(1)
    h.runs[0].resolve([status("claude", "fresh")])
    await drain()
    expect(h.cacheNow()?.statuses[0].version).toBe("fresh")
    expect(h.emitted).toHaveLength(1)
  })

  it("kickIfStale probes when there is no cache at all", async () => {
    const h = harness()
    h.refresher.kickIfStale()
    expect(h.runs).toHaveLength(1)
    h.runs[0].resolve([])
    await drain()
  })

  it("kickIfStale never stacks onto a running probe", async () => {
    const h = harness()
    void h.refresher.refresh()
    h.refresher.kickIfStale()
    h.refresher.kickIfStale()
    expect(h.runs).toHaveLength(1)
    h.runs[0].resolve([])
    await drain()
  })

  it("stamps cachedAt from the injected clock and hands it to emit", async () => {
    const clock = vi.fn(() => 42)
    const h = harness({ now: clock })
    const p = h.refresher.refresh()
    h.runs[0].resolve([])
    await p
    expect(h.emitted[0].cachedAt).toBe(42)
    expect(h.saved[0].cachedAt).toBe(42)
  })

  it("keeps emitting after a cache save failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const emitted: number[] = []
    const refresher = new ProviderStatusRefresher({
      probe: async () => [],
      configKey: () => "k",
      cache: {
        current: null,
        set: async () => {
          throw new Error("disk full")
        },
      },
      emit: (_statuses, cachedAt) => emitted.push(cachedAt),
    })
    await refresher.refresh()
    expect(emitted).toHaveLength(1)
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})
