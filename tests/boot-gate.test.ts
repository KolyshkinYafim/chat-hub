import { mkdtemp } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { NotificationService } from "../src/main/notifications"

const electronLog: string[] = []
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => `/tmp/chat-hub-boot-gate/${name}`,
    setPath: () => {},
    requestSingleInstanceLock: () => false,
    quit: () => {},
    exit: (code: number) => {
      electronLog.push(`exit:${code}`)
    },
    on: () => {},
    whenReady: () => new Promise<void>(() => {}),
    setName: () => {},
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return []
    }
    static getFocusedWindow(): unknown {
      return null
    }
  },
  dialog: {
    showErrorBox: (title: string, content: string) => {
      electronLog.push(`errorBox:${title}:${content.split("\n")[0]}`)
    },
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
    on: () => {},
  },
  shell: {},
  nativeTheme: {
    prefersReducedTransparency: false,
    on: () => {},
  },
  nativeImage: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}))

const { registerIpc, failBootstrap, bootReadyChain } = await import(
  "../src/main/index"
)
const { IpcChannels } = await import("../src/shared/ipc")
const { SessionManager } = await import("../src/main/session-manager")
const { EventBus } = await import("../src/main/event-bus")
const { Persistence } = await import("../src/main/persistence")
const { SessionMonitorBridge } = await import("../src/main/bridge")
const { SettingsStore } = await import("../src/main/settings")
const { ProjectStore } = await import("../src/main/project-store")
const { UsageLedger } = await import("../src/main/usage-ledger")
const { ProviderStatusCacheStore } = await import(
  "../src/main/provider-status-cache"
)
const { ProviderStatusRefresher } = await import(
  "../src/main/provider-status-refresh"
)
const { PrStatusWatcher } = await import("../src/main/pr-status")

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function drain(ms = 25) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function fixture(ready: Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-boot-gate-"))
  const bus = new EventBus()
  const persistence = new Persistence(join(dir, "state.json"))
  const settings = new SettingsStore(join(dir, "settings.json"))
  await settings.load()
  const projects = new ProjectStore(join(dir, "projects.json"))
  const bridge = new SessionMonitorBridge(join(dir, "events.jsonl"))
  const usageLedger = new UsageLedger(join(dir, "usage.json"))
  const sm = new SessionManager(
    bus,
    persistence,
    bridge,
    { handle: () => {} } as unknown as NotificationService,
    settings,
    { intervalMs: 60_000, silenceMs: 60_000 },
    { titleGenerator: async () => null },
  )
  const refresher = new ProviderStatusRefresher({
    probe: async () => [],
    configKey: () => "test",
    cache: new ProviderStatusCacheStore(join(dir, "provider-status-cache.json")),
    emit: () => {},
  })
  const prStatus = new PrStatusWatcher({
    fetch: async () => ({ pr: null }),
    liveCwds: () => [],
    emit: () => {},
  })
  handlers.clear()
  registerIpc(
    sm,
    bridge,
    settings,
    projects,
    dir,
    usageLedger,
    refresher,
    prStatus,
    ready,
  )
  return { dir, sm, projects, persistence }
}

describe("mutating IPC is gated on the ready promise", () => {
  it("createSession cannot touch state before ready resolves", async () => {
    const gate = deferred()
    const { dir, sm } = await fixture(gate.promise)
    const handler = handlers.get(IpcChannels.createSession)!

    const call = Promise.resolve(
      handler({}, { provider: "mock", cwd: dir }),
    )
    let settled = false
    void call.finally(() => {
      settled = true
    })
    await drain()
    expect(settled).toBe(false)
    expect(sm.listSessions()).toHaveLength(0)
    expect(existsSync(join(dir, "state.json"))).toBe(false)

    gate.resolve()
    await call
    expect(sm.listSessions()).toHaveLength(1)
  })

  it("sendMessage and migrateArchived wait for ready", async () => {
    const gate = deferred()
    await fixture(gate.promise)
    const send = handlers.get(IpcChannels.sendMessage)!
    const migrate = handlers.get(IpcChannels.sessionMigrateArchived)!

    const sends = Promise.resolve(send({}, "ghost", "hello")).then(
      () => "resolved",
      () => "rejected",
    )
    const migrates = Promise.resolve(migrate({}, ["ghost"])).then(
      () => "resolved",
      () => "rejected",
    )
    let done = 0
    void sends.finally(() => done++)
    void migrates.finally(() => done++)
    await drain()
    expect(done).toBe(0)

    gate.resolve()
    expect(await sends).toBe("rejected")
    expect(await migrates).toBe("resolved")
  })

  it("addProject cannot write projects.json before ready resolves", async () => {
    const gate = deferred()
    const { dir, projects } = await fixture(gate.promise)
    const handler = handlers.get(IpcChannels.addProject)!

    const call = Promise.resolve(handler({}, dir))
    let settled = false
    void call.finally(() => {
      settled = true
    })
    await drain()
    expect(settled).toBe(false)
    expect(existsSync(join(dir, "projects.json"))).toBe(false)

    gate.resolve()
    await call
    expect(projects.list()).toHaveLength(1)
    expect(existsSync(join(dir, "projects.json"))).toBe(true)
  })

  it("delete and archive paths wait for ready", async () => {
    const gate = deferred()
    await fixture(gate.promise)
    const del = handlers.get(IpcChannels.deleteSession)!
    const archive = handlers.get(IpcChannels.sessionSetArchived)!

    let done = 0
    const deletes = Promise.resolve(del({}, "ghost")).catch(() => undefined)
    const archives = Promise.resolve(archive({}, "ghost", true)).catch(
      () => undefined,
    )
    void deletes.finally(() => done++)
    void archives.finally(() => done++)
    await drain()
    expect(done).toBe(0)

    gate.resolve()
    await Promise.all([deletes, archives])
    expect(done).toBe(2)
  })
})

describe("bootReadyChain", () => {
  it("backfills session folders into projects before ready resolves", async () => {
    const gate = deferred()
    const { dir, sm } = await fixture(gate.promise)
    gate.resolve()
    const handler = handlers.get(IpcChannels.createSession)!
    await handler({}, { provider: "mock", cwd: dir })
    await sm.flush()

    const bus = new EventBus()
    const restarted = new SessionManager(
      bus,
      new Persistence(join(dir, "state.json")),
      new SessionMonitorBridge(join(dir, "events2.jsonl")),
      { handle: () => {} } as unknown as NotificationService,
      new SettingsStore(join(dir, "settings.json")),
      { intervalMs: 60_000, silenceMs: 60_000 },
      { titleGenerator: async () => null },
    )
    const freshProjects = new ProjectStore(join(dir, "projects2.json"))
    const brokerCalls: string[] = []

    await bootReadyChain({
      projects: freshProjects,
      sm: restarted,
      usageLedger: new UsageLedger(join(dir, "usage2.json")),
      startBroker: async () => {
        brokerCalls.push("started")
      },
    })

    expect(brokerCalls).toEqual(["started"])
    expect(restarted.listSessions()).toHaveLength(1)
    expect(freshProjects.list().map((p) => p.cwd)).toContain(
      restarted.listSessions()[0].cwd,
    )
  })
})

describe("failBootstrap", () => {
  it("surfaces a native error dialog and then exits non-zero", () => {
    electronLog.length = 0
    failBootstrap(new Error("stores unreadable"))
    expect(electronLog).toHaveLength(2)
    expect(electronLog[0]).toMatch(/^errorBox:Chat Hub failed to start:/)
    expect(electronLog[1]).toBe("exit:1")
  })
})
