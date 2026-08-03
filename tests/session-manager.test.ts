import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { HubEvent } from "../src/shared/types"
import type { AdapterCallbacks, AdapterStartOpts } from "../src/main/adapters/types"
import type { NotificationService } from "../src/main/notifications"
import type { WatchdogConfig } from "../src/main/session-manager"

// safeStorage only exists inside a running Electron main process.
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}))

// One controllable adapter for every provider: a turn ends only when the test
// says so, which is what makes queueing and the watchdog observable.
const { adapter, state } = vi.hoisted(() => {
  const state = {
    sent: [] as string[],
    aborted: [] as string[],
    pending: null as {
      resolve: () => void
      reject: (err: unknown) => void
    } | null,
    startEmitsRunning: false,
    startThrows: false,
    // A real CLI reports "running" a tick late; turning this off reproduces
    // that window, where only the in-flight turn itself marks the session busy.
    sendEmitsRunning: true,
    /** What the fake CLI's result line reports for the next turn, if anything. */
    usage: null as { costUsd?: number; outputTokens?: number } | null,
    lastEnv: undefined as Record<string, string> | undefined,
    lastPermissionMode: undefined as string | undefined,
  }
  const adapter = {
    id: "mock" as const,
    available: true,
    async start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void> {
      if (state.startThrows) throw new Error("binary not found")
      if (state.startEmitsRunning) {
        cb.onSessionEvent({
          type: "session.status",
          id: opts.sessionId,
          status: "running",
        })
      }
    },
    send(
      sessionId: string,
      message: string,
      cb: AdapterCallbacks,
      opts?: { env?: Record<string, string>; permissionMode?: string },
    ): Promise<void> {
      state.sent.push(message)
      state.lastEnv = opts?.env
      state.lastPermissionMode = opts?.permissionMode
      if (state.sendEmitsRunning) {
        cb.onSessionEvent({
          type: "session.status",
          id: sessionId,
          status: "running",
        })
      }
      return new Promise<void>((resolve, reject) => {
        state.pending = {
          resolve: () => {
            if (state.usage) cb.onUsage?.(sessionId, state.usage, undefined)
            resolve()
          },
          reject,
        }
      })
    },
    async abort(sessionId: string): Promise<void> {
      state.aborted.push(sessionId)
    },
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

const { SessionManager } = await import("../src/main/session-manager")
const { EventBus } = await import("../src/main/event-bus")
const { Persistence } = await import("../src/main/persistence")
const { SessionMonitorBridge } = await import("../src/main/bridge")
const { SettingsStore } = await import("../src/main/settings")

async function makeManager(watchdog?: WatchdogConfig) {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-sm-"))
  const persistence = new Persistence(join(dir, "state.json"))
  const settings = new SettingsStore(join(dir, "settings.json"))
  await settings.load()
  const notifications = { handle: () => {} } as unknown as NotificationService
  const bus = new EventBus()
  const events: HubEvent[] = []
  bus.on((e) => events.push(e))
  const sm = new SessionManager(
    bus,
    persistence,
    new SessionMonitorBridge(join(dir, "events.jsonl")),
    notifications,
    settings,
    watchdog ?? { intervalMs: 60_000, silenceMs: 60_000 },
  )
  await sm.init()
  return { sm, dir, persistence, events }
}

beforeEach(() => {
  state.sent = []
  state.aborted = []
  state.pending = null
  state.startEmitsRunning = false
  state.startThrows = false
  state.sendEmitsRunning = true
  state.usage = null
  state.lastEnv = undefined
  state.lastPermissionMode = undefined
})

describe("cost & tokens", () => {
  it("accumulates per-turn usage into a session total and publishes it", async () => {
    const { sm, dir, events } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    state.usage = { costUsd: 0.5, outputTokens: 100 }
    await sm.sendMessage(session.id, "one")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getUsage(session.id)?.turns).toBe(1))

    state.usage = { costUsd: 0.25, outputTokens: 40 }
    await sm.sendMessage(session.id, "two")
    state.pending?.resolve()

    await vi.waitFor(() =>
      expect(sm.getUsage(session.id)).toEqual({
        turns: 2,
        costUsd: 0.75,
        outputTokens: 140,
      }),
    )
    expect(events.filter((e) => e.type === "usage.changed")).toHaveLength(2)
    expect(sm.getSnapshot().usage[session.id]?.turns).toBe(2)
  })

  it("leaves a session no CLI reported usage for out of the snapshot", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "one")
    state.pending?.resolve()

    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
    // A zero here would claim a free turn; absence is what hides the chip.
    expect(sm.getSnapshot().usage).toEqual({})
  })

  it("carries the total across a restart", async () => {
    const { sm, dir, persistence } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    state.usage = { costUsd: 1.5 }
    await sm.sendMessage(session.id, "one")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getUsage(session.id)?.turns).toBe(1))

    await sm.flush()
    expect((await persistence.load()).usage?.[session.id]).toEqual({
      turns: 1,
      costUsd: 1.5,
    })
  })
})

describe("permission routing", () => {
  it("points a Claude session's hook at the Hub socket", async () => {
    const { sm, dir } = await makeManager()
    sm.setPermissionBroker({
      socketPath: "/tmp/hub-test.sock",
      list: () => [],
      cancelForSession: () => {},
    } as unknown as Parameters<typeof sm.setPermissionBroker>[0])
    const session = await sm.createSession({ provider: "claude", cwd: dir })
    await sm.sendMessage(session.id, "hello")

    expect(state.lastEnv?.AGENT_DESKTOP_SOCKET).toBe("/tmp/hub-test.sock")
  })

  it("leaves OpenCode alone — the same variable is its plugin's event channel", async () => {
    const { sm, dir } = await makeManager()
    sm.setPermissionBroker({
      socketPath: "/tmp/hub-test.sock",
      list: () => [],
      cancelForSession: () => {},
    } as unknown as Parameters<typeof sm.setPermissionBroker>[0])
    const session = await sm.createSession({ provider: "opencode", cwd: dir })
    await sm.sendMessage(session.id, "hello")

    expect(state.lastEnv?.AGENT_DESKTOP_SOCKET).toBeUndefined()
  })

  it("maps a hook's namespaced agent id back onto its Hub session", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "claude", cwd: dir })
    await sm.sendMessage(session.id, "hello")

    expect(sm.findSessionForAgent("claude-xyz")).toBeNull()
    // Only the cwd is known until the CLI announces its own id.
    expect(sm.findSessionForAgent("claude-xyz", session.cwd)).toBe(session.id)
  })
})

describe("session cwd", () => {
  it("refuses a session with no folder instead of rooting the agent at process.cwd()", async () => {
    const { sm } = await makeManager()
    await expect(sm.createSession({ provider: "mock" })).rejects.toThrow(
      /folder required/i,
    )
    expect(sm.listSessions()).toEqual([])
  })

  it("rolls back a session whose adapter failed to start", async () => {
    const { sm, dir } = await makeManager()
    state.startThrows = true
    await expect(
      sm.createSession({ provider: "mock", cwd: dir }),
    ).rejects.toThrow(/binary not found/)
    expect(sm.listSessions()).toEqual([])
    expect(sm.getSnapshot().activeSessionId).toBeNull()
  })
})

describe("message queue", () => {
  it("queues a message sent mid-turn and flushes it when the turn ends", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "first")
    expect(state.sent).toEqual(["first"])
    expect(sm.getSession(session.id)?.status).toBe("running")

    await sm.sendMessage(session.id, "second")
    // The live turn must not be pre-empted…
    expect(state.sent).toEqual(["first"])
    // …but the user still sees what they typed.
    expect(
      sm.getMessages(session.id)
        .filter((m) => m.role === "user")
        .map((m) => m.content),
    ).toEqual(["first", "second"])

    state.pending?.resolve()
    await vi.waitFor(() => expect(state.sent).toEqual(["first", "second"]))
  })

  it("keeps queue order across several queued messages", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "one")
    await sm.sendMessage(session.id, "two")
    await sm.sendMessage(session.id, "three")

    state.pending?.resolve()
    await vi.waitFor(() => expect(state.sent).toEqual(["one", "two"]))
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(state.sent).toEqual(["one", "two", "three"]),
    )
  })

  it("says so instead of silently dropping the queue when the turn fails", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "first")
    await sm.sendMessage(session.id, "second")

    state.pending?.reject(new Error("CLI died"))
    await vi.waitFor(() => {
      expect(sm.getSession(session.id)?.status).toBe("error")
      expect(
        sm.getMessages(session.id).some(
          (m) => m.role === "system" && /queued message/i.test(m.content),
        ),
      ).toBe(true)
    })
    expect(state.sent).toEqual(["first"])
  })

  it("queues the second of two sends the adapter has not reported running yet", async () => {
    const { sm, dir } = await makeManager()
    state.sendEmitsRunning = false
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "first")
    await sm.sendMessage(session.id, "second")

    // The adapter refuses a concurrent send, so dispatching both would fail the
    // session while the first turn is still alive.
    expect(state.sent).toEqual(["first"])
    expect(sm.listQueued(session.id).map((q) => q.text)).toEqual(["second"])
  })
})

describe("queue surface", () => {
  it("publishes the queue so the renderer never keeps its own copy", async () => {
    const { sm, dir, events } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "first")
    await sm.sendMessage(session.id, "second")

    const queueEvents = events.filter((e) => e.type === "queue.changed")
    expect(queueEvents.at(-1)).toMatchObject({
      sessionId: session.id,
      queued: [{ text: "second" }],
    })
    // Hydration after a renderer reload comes from the same source.
    expect(sm.getSnapshot().queued[session.id]).toHaveLength(1)
  })

  it("cancels a queued message so it is never dispatched", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "first")
    await sm.sendMessage(session.id, "second")

    const [queued] = sm.listQueued(session.id)
    expect(sm.cancelQueued(session.id, queued.id)).toEqual([])

    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
    expect(state.sent).toEqual(["first"])
    expect(sm.getSnapshot().queued).toEqual({})
  })

  it("drops the queue on Stop rather than firing it at a turn the user killed", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "first")
    await sm.sendMessage(session.id, "second")

    await sm.abortSession(session.id)
    state.pending?.resolve()

    await vi.waitFor(() =>
      expect(
        sm.getMessages(session.id).some(
          (m) => m.role === "system" && /was stopped/i.test(m.content),
        ),
      ).toBe(true),
    )
    expect(state.sent).toEqual(["first"])
    expect(sm.listQueued(session.id)).toEqual([])
  })
})

describe("watchdog", () => {
  it("never leaves a session running with no live process", async () => {
    const { sm, dir } = await makeManager()
    state.startEmitsRunning = true
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    expect(sm.getSession(session.id)?.status).toBe("running")

    sm.checkStuckSessions()

    expect(sm.getSession(session.id)?.status).toBe("idle")
    expect(
      sm.getMessages(session.id).some(
        (m) => m.role === "system" && /no agent process/i.test(m.content),
      ),
    ).toBe(true)
  })

  it("kills a turn that has gone silent past the timeout", async () => {
    const { sm, dir } = await makeManager({
      intervalMs: 60_000,
      silenceMs: 1_000,
    })
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "hello")

    sm.checkStuckSessions(Date.now() + 10_000)

    expect(sm.getSession(session.id)?.status).toBe("error")
    expect(state.aborted).toContain(session.id)
    expect(
      sm.getMessages(session.id).some(
        (m) => m.role === "system" && /no output/i.test(m.content),
      ),
    ).toBe(true)
  })

  it("leaves a turn that is still producing output alone", async () => {
    const { sm, dir } = await makeManager({
      intervalMs: 60_000,
      silenceMs: 60_000,
    })
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "hello")

    sm.checkStuckSessions(Date.now() + 1_000)

    expect(sm.getSession(session.id)?.status).toBe("running")
    expect(state.aborted).toEqual([])
  })
})

describe("shutdown", () => {
  it("stops live turns and persists them as idle, not running", async () => {
    const { sm, dir, persistence } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "hello")
    expect(sm.getSession(session.id)?.status).toBe("running")

    await sm.shutdown()

    expect(state.aborted).toContain(session.id)
    const persisted = await persistence.load()
    expect(persisted.sessions.find((s) => s.id === session.id)?.status).toBe(
      "idle",
    )
  })
})

describe("per-session permission mode", () => {
  it("follows the global default until the session overrides it", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "one")
    expect(state.lastPermissionMode).toBe("yolo")
    state.pending?.resolve()

    await sm.setPermissionMode("acceptEdits")
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
    await sm.sendMessage(session.id, "two")
    // No override, so a changed default reaches the session.
    expect(state.lastPermissionMode).toBe("acceptEdits")
    state.pending?.resolve()
  })

  it("sends one session's override without retuning its neighbours", async () => {
    const { sm, dir } = await makeManager()
    const a = await sm.createSession({ provider: "mock", cwd: dir })
    const b = await sm.createSession({ provider: "mock", cwd: dir })

    sm.setSessionPermissionMode(a.id, "default")

    await sm.sendMessage(a.id, "ask me")
    expect(state.lastPermissionMode).toBe("default")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(a.id)?.status).toBe("idle"))

    await sm.sendMessage(b.id, "yolo me")
    expect(state.lastPermissionMode).toBe("yolo")
    state.pending?.resolve()

    expect(sm.getPermissionMode()).toBe("yolo")
  })

  it("clearing the override goes back to following the default, not freezing it", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    sm.setSessionPermissionMode(session.id, "default")
    expect(sm.getSession(session.id)?.permissionMode).toBe("default")

    sm.setSessionPermissionMode(session.id, undefined)
    expect(sm.getSession(session.id)?.permissionMode).toBeUndefined()

    await sm.setPermissionMode("acceptEdits")
    await sm.sendMessage(session.id, "x")
    expect(state.lastPermissionMode).toBe("acceptEdits")
    state.pending?.resolve()
  })

  it("keeps the override across a restart", async () => {
    const { sm, dir, persistence } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    sm.setSessionPermissionMode(session.id, "acceptEdits")
    await sm.flush()

    const saved = (await persistence.load()).sessions.find((s) => s.id === session.id)
    expect(saved?.permissionMode).toBe("acceptEdits")
  })
})
