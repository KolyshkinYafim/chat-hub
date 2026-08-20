import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { UsageLedgerEntry } from "../src/shared/types"
import type { AdapterCallbacks, AdapterStartOpts } from "../src/main/adapters/types"
import type { NotificationService } from "../src/main/notifications"

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}))

const { adapter, state } = vi.hoisted(() => {
  const state = {
    pending: null as { resolve: () => void } | null,
    usage: null as { costUsd?: number; inputTokens?: number; outputTokens?: number } | null,
  }
  const adapter = {
    id: "mock" as const,
    available: true,
    async start(_opts: AdapterStartOpts, _cb: AdapterCallbacks): Promise<void> {},
    send(
      sessionId: string,
      _message: string,
      cb: AdapterCallbacks,
    ): Promise<void> {
      cb.onSessionEvent({ type: "session.status", id: sessionId, status: "running" })
      return new Promise<void>((resolve) => {
        state.pending = {
          resolve: () => {
            if (state.usage) cb.onUsage?.(sessionId, state.usage, undefined)
            resolve()
          },
        }
      })
    },
    async abort(_sessionId: string): Promise<void> {},
    async dispose(): Promise<void> {},
  }
  return { adapter, state }
})

vi.mock("../src/main/adapters", () => ({
  getAdapter: () => adapter,
  listAdapters: () => [adapter],
  refreshProviders: () => {},
  listProviderInfo: () => [],
}))

const { UsageLedger, mergeLedgerEntry, rollupWindows, seedFromSessions } =
  await import("../src/main/usage-ledger")
const { dayKey } = await import("../src/shared/day")
const { SessionManager } = await import("../src/main/session-manager")
const { EventBus } = await import("../src/main/event-bus")
const { Persistence } = await import("../src/main/persistence")
const { SessionMonitorBridge } = await import("../src/main/bridge")
const { SettingsStore } = await import("../src/main/settings")

const DAY_MS = 86_400_000

function entry(patch: Partial<UsageLedgerEntry>): UsageLedgerEntry {
  return {
    day: "2026-08-19",
    provider: "claude",
    model: "opus",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    turns: 1,
    ...patch,
  }
}

beforeEach(() => {
  state.pending = null
  state.usage = null
})

describe("merge math", () => {
  it("accumulates onto the row sharing day, provider, and model", () => {
    const merged = mergeLedgerEntry(
      [entry({ inputTokens: 100, outputTokens: 10, costUsd: 0.5 })],
      entry({ inputTokens: 40, outputTokens: 4, costUsd: 0.25 }),
    )
    expect(merged).toEqual([
      entry({ inputTokens: 140, outputTokens: 14, costUsd: 0.75, turns: 2 }),
    ])
  })

  it("keeps rows apart when any key differs", () => {
    let entries = [entry({ costUsd: 1 })]
    entries = mergeLedgerEntry(entries, entry({ day: "2026-08-18", costUsd: 2 }))
    entries = mergeLedgerEntry(entries, entry({ provider: "codex", costUsd: 4 }))
    entries = mergeLedgerEntry(entries, entry({ model: "sonnet", costUsd: 8 }))
    expect(entries).toHaveLength(4)
    expect(entries.map((e) => e.costUsd)).toEqual([1, 2, 4, 8])
    expect(entries.every((e) => e.turns === 1)).toBe(true)
  })
})

describe("rollup windows", () => {
  const now = new Date(2026, 7, 19, 12, 0, 0).getTime()

  it("splits today / 7d / 30d on inclusive day boundaries", () => {
    const entries = [
      entry({ day: dayKey(now), costUsd: 1, turns: 1 }),
      entry({ day: dayKey(now - 6 * DAY_MS), costUsd: 2, turns: 2 }),
      entry({ day: dayKey(now - 7 * DAY_MS), costUsd: 4, turns: 4 }),
      entry({ day: dayKey(now - 29 * DAY_MS), costUsd: 8, turns: 8 }),
      entry({ day: dayKey(now - 30 * DAY_MS), costUsd: 16, turns: 16 }),
    ]
    const { today, last7d, last30d } = rollupWindows(entries, now)
    expect(today).toMatchObject({ costUsd: 1, turns: 1 })
    expect(last7d).toMatchObject({ costUsd: 3, turns: 3 })
    expect(last30d).toMatchObject({ costUsd: 15, turns: 15 })
  })

  it("ignores days after now", () => {
    const entries = [entry({ day: dayKey(now + DAY_MS), costUsd: 99 })]
    expect(rollupWindows(entries, now).last30d.costUsd).toBe(0)
  })
})

describe("file persistence", () => {
  it("round-trips entries through disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-ledger-"))
    const path = join(dir, "usage-ledger.json")
    const now = new Date(2026, 7, 19, 12).getTime()

    const ledger = new UsageLedger(path, () => now)
    await ledger.init()
    await ledger.record("claude", "opus", {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 9000,
      cacheCreateTokens: 300,
      costUsd: 0.5,
    })
    await ledger.record("claude", "opus", {
      inputTokens: 40,
      cacheReadTokens: 1000,
      costUsd: 0.25,
    })

    const reopened = new UsageLedger(path, () => now)
    await reopened.init()
    expect(reopened.summary().entries).toEqual([
      {
        day: dayKey(now),
        provider: "claude",
        model: "opus",
        inputTokens: 140,
        outputTokens: 10,
        cacheReadTokens: 10_000,
        cacheCreateTokens: 300,
        costUsd: 0.75,
        turns: 2,
      },
    ])
    expect(reopened.summary().today.costUsd).toBe(0.75)
  })

  it("treats a garbage file as an empty ledger and keeps recording", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-ledger-"))
    const path = join(dir, "usage-ledger.json")
    await writeFile(path, "{ not json", "utf8")

    const ledger = new UsageLedger(path)
    await ledger.init()
    expect(ledger.summary().entries).toEqual([])

    await ledger.record("codex", undefined, { costUsd: 0.1 })
    expect(ledger.summary().entries).toMatchObject([
      { provider: "codex", model: "unknown", costUsd: 0.1, turns: 1 },
    ])
    expect(JSON.parse(await readFile(path, "utf8")).entries).toHaveLength(1)
  })

  it("reads a pre-cache-column ledger back with zeroed cache counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-ledger-"))
    const path = join(dir, "usage-ledger.json")
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          {
            day: "2026-08-19",
            provider: "claude",
            model: "opus",
            inputTokens: 100,
            outputTokens: 10,
            costUsd: 0.5,
            turns: 1,
          },
        ],
      }),
      "utf8",
    )

    const ledger = new UsageLedger(path)
    await ledger.init()
    expect(ledger.summary().entries[0]).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    })
  })

  it("seeds a missing file from per-session totals on their updatedAt day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-ledger-"))
    const path = join(dir, "usage-ledger.json")
    const updatedAt = new Date(2026, 7, 18, 9).getTime()
    const seed = seedFromSessions(
      [
        {
          id: "s1",
          title: "t",
          project: "p",
          provider: "claude",
          model: "opus",
          cwd: dir,
          status: "idle",
          createdAt: updatedAt,
          updatedAt,
        },
        {
          id: "s2",
          title: "t",
          project: "p",
          provider: "grok",
          cwd: dir,
          status: "idle",
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      {
        s1: {
          turns: 3,
          costUsd: 1.2,
          inputTokens: 500,
          outputTokens: 50,
          cacheReadTokens: 12_000,
        },
      },
    )

    const ledger = new UsageLedger(path)
    await ledger.init(seed)
    expect(ledger.summary().entries).toEqual([
      {
        day: dayKey(updatedAt),
        provider: "claude",
        model: "opus",
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 12_000,
        cacheCreateTokens: 0,
        costUsd: 1.2,
        turns: 3,
      },
    ])
    expect(JSON.parse(await readFile(path, "utf8")).entries).toHaveLength(1)
  })
})

describe("session-manager hook", () => {
  async function makeManager() {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-ledger-sm-"))
    const persistence = new Persistence(join(dir, "state.json"))
    const settings = new SettingsStore(join(dir, "settings.json"))
    await settings.load()
    const ledger = new UsageLedger(join(dir, "usage-ledger.json"))
    await ledger.init()
    const sm = new SessionManager(
      new EventBus(),
      persistence,
      new SessionMonitorBridge(join(dir, "events.jsonl")),
      { handle: () => {} } as unknown as NotificationService,
      settings,
      { intervalMs: 60_000, silenceMs: 60_000 },
      { usageLedger: ledger },
    )
    await sm.init()
    return { sm, dir, ledger }
  }

  it("writes exactly one ledger entry per completed turn", async () => {
    const { sm, dir, ledger } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    state.usage = { costUsd: 0.5, inputTokens: 100, outputTokens: 20 }
    await sm.sendMessage(session.id, "one")
    state.pending?.resolve()
    await vi.waitFor(() => expect(ledger.summary().entries).toHaveLength(1))

    state.usage = { costUsd: 0.25, inputTokens: 30 }
    await sm.sendMessage(session.id, "two")
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(ledger.summary().entries[0]?.turns).toBe(2),
    )

    expect(ledger.summary().entries).toEqual([
      {
        day: dayKey(Date.now()),
        provider: "mock",
        model: "unknown",
        inputTokens: 130,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 0.75,
        turns: 2,
      },
    ])
  })

  it("records nothing for a turn whose CLI reported no usage", async () => {
    const { sm, dir, ledger } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "one")
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("idle"),
    )
    expect(ledger.summary().entries).toEqual([])
  })
})
