import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { HubEvent } from "../src/shared/types"
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
    sent: [] as string[],
    pending: null as {
      resolve: () => void
      reject: (err: unknown) => void
    } | null,
    cb: null as AdapterCallbacks | null,
  }
  const adapter = {
    id: "mock" as const,
    available: true,
    async start(_opts: AdapterStartOpts, _cb: AdapterCallbacks): Promise<void> {},
    send(
      sessionId: string,
      message: string,
      cb: AdapterCallbacks,
    ): Promise<void> {
      state.sent.push(message)
      state.cb = cb
      cb.onSessionEvent({
        type: "session.status",
        id: sessionId,
        status: "running",
      })
      return new Promise<void>((resolve, reject) => {
        state.pending = { resolve, reject }
      })
    },
    async abort(): Promise<void> {},
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

async function makeManager(at?: string) {
  const dir = at ?? (await mkdtemp(join(tmpdir(), "chat-hub-settled-")))
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
    { intervalMs: 60_000, silenceMs: 60_000 },
  )
  await sm.init()
  return { sm, dir, persistence, events }
}

async function runTurn(
  sm: InstanceType<typeof SessionManager>,
  sessionId: string,
  text: string,
) {
  await sm.sendMessage(sessionId, text)
  state.pending?.resolve()
  await vi.waitFor(() =>
    expect(sm.getSession(sessionId)?.settledAt).toBeDefined(),
  )
}

beforeEach(() => {
  state.sent = []
  state.pending = null
})

describe("auto-settle", () => {
  it("settles a thread when its turn ends cleanly", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    expect(sm.getSession(session.id)?.settledAt).toBeUndefined()

    await sm.sendMessage(session.id, "hello")
    expect(sm.getSession(session.id)?.settledAt).toBeUndefined()
    state.pending?.resolve()

    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.settledAt).toBeDefined(),
    )
    expect(sm.getSession(session.id)?.settledBy).toBe("auto")
  })

  it("holds off while a follow-up is queued, then settles once the queue drains", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "one")
    await sm.sendMessage(session.id, "two")
    state.pending?.resolve()

    await vi.waitFor(() => expect(state.sent).toHaveLength(2))
    expect(sm.getSession(session.id)?.settledAt).toBeUndefined()

    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.settledAt).toBeDefined(),
    )
    expect(sm.getSession(session.id)?.settledBy).toBe("auto")
  })

  it("does not settle a turn that failed", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "boom")
    state.pending?.reject(new Error("cli died"))

    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("error"),
    )
    expect(sm.getSession(session.id)?.settledAt).toBeUndefined()
  })
})

describe("unsettle on activity", () => {
  it("a new user message unsettles a settled thread", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await runTurn(sm, session.id, "first")

    await sm.sendMessage(session.id, "again")
    expect(sm.getSession(session.id)?.settledAt).toBeUndefined()
    expect(sm.getSession(session.id)?.settledBy).toBeUndefined()
  })
})

describe("manual settle / unsettle", () => {
  it("stamps a manual settle as settledBy user", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    const next = sm.setSessionSettled(session.id, true)
    expect(next.settledAt).toBeDefined()
    expect(next.settledBy).toBe("user")
  })

  it("user un-settle sticks through the next event but re-settles on the next completed turn", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await runTurn(sm, session.id, "first")

    const next = sm.setSessionSettled(session.id, false)
    expect(next.settledAt).toBeUndefined()

    sm.checkStuckSessions()
    expect(sm.getSession(session.id)?.settledAt).toBeUndefined()

    await sm.sendMessage(session.id, "second")
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.settledAt).toBeDefined(),
    )
    expect(sm.getSession(session.id)?.settledBy).toBe("auto")
  })
})

describe("archive", () => {
  it("archiving implies settled; unarchiving keeps the thread settled", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    const archived = sm.setSessionArchived(session.id, true)
    expect(archived.archived).toBe(true)
    expect(archived.settledAt).toBeDefined()
    expect(archived.settledBy).toBe("user")

    const unarchived = sm.setSessionArchived(session.id, false)
    expect(unarchived.archived).toBeUndefined()
    expect(unarchived.settledAt).toBeDefined()
  })

  it("migrates known legacy ids and drops unknown ones silently", async () => {
    const { sm, dir } = await makeManager()
    const a = await sm.createSession({ provider: "mock", cwd: dir })
    const b = await sm.createSession({ provider: "mock", cwd: dir })

    sm.migrateArchived([a.id, "no-such-session"])

    expect(sm.getSession(a.id)?.archived).toBe(true)
    expect(sm.getSession(a.id)?.settledAt).toBeDefined()
    expect(sm.getSession(b.id)?.archived).toBeUndefined()
    expect(sm.getSession(b.id)?.settledAt).toBeUndefined()
  })
})

describe("persistence", () => {
  it("round-trips settledAt, settledBy and archived through state.json", async () => {
    const { sm, dir, persistence } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await runTurn(sm, session.id, "work")
    sm.setSessionArchived(session.id, true)
    await sm.flush()

    const saved = (await persistence.load()).sessions.find(
      (s) => s.id === session.id,
    )
    expect(saved?.settledAt).toBeDefined()
    expect(saved?.settledBy).toBe("auto")
    expect(saved?.archived).toBe(true)

    const { sm: reborn } = await makeManager(dir)
    const restored = reborn.getSession(session.id)
    expect(restored?.settledAt).toBe(saved?.settledAt)
    expect(restored?.settledBy).toBe("auto")
    expect(restored?.archived).toBe(true)
  })
})

describe("failed and stopped turns", () => {
  it("does not settle a turn whose CLI exited non-zero without rejecting", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "go")

    state.cb?.onSessionEvent({
      type: "session.status",
      id: session.id,
      status: "error",
    })
    state.pending?.resolve()
    await new Promise((r) => setTimeout(r, 20))

    expect(sm.getSession(session.id)?.settledAt).toBeUndefined()
  })

  it("a stopped turn's late resolution cannot settle or idle the resend", async () => {
    const { sm, dir } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "first")
    const stale = state.pending

    await sm.abortSession(session.id)
    await sm.sendMessage(session.id, "second")
    const live = state.pending
    expect(live).not.toBe(stale)

    stale?.resolve()
    await new Promise((r) => setTimeout(r, 20))

    expect(sm.getSession(session.id)?.settledAt).toBeUndefined()
    live?.resolve()
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.settledAt).toBeDefined(),
    )
  })
})
