import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
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
    startDelay: null as Promise<void> | null,
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
      if (state.startDelay) await state.startDelay
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

const { SessionManager, MAX_MESSAGES_PER_SESSION } = await import(
  "../src/main/session-manager"
)
const { EventBus } = await import("../src/main/event-bus")
const { Persistence } = await import("../src/main/persistence")
const { SessionMonitorBridge } = await import("../src/main/bridge")
const { SettingsStore } = await import("../src/main/settings")
const { PermissionBroker } = await import("../src/main/permission-broker")
const { MessageArchive } = await import("../src/main/message-archive")

const exec = promisify(execFile)

async function makeManager(
  watchdog?: WatchdogConfig,
  opts?: { maxMessages?: number },
) {
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
    // Never the real one: it shells out to the claude CLI.
    { maxMessages: opts?.maxMessages, titleGenerator: async () => null },
  )
  await sm.init()
  return { sm, dir, persistence, events, bus }
}

beforeEach(() => {
  state.sent = []
  state.aborted = []
  state.pending = null
  state.startEmitsRunning = false
  state.startThrows = false
  state.startDelay = null
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
        lastTurn: { costUsd: 0.25, outputTokens: 40 },
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
      lastTurn: { costUsd: 1.5 },
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

  it("starts an opted-in session in an isolated worktree and cleans it up", async () => {
    const { sm } = await makeManager()
    const repo = await mkdtemp(join(tmpdir(), "chat-hub-session-repo-"))
    await exec("git", ["init", "-q"], { cwd: repo })
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo })
    await exec("git", ["config", "user.name", "Chat Hub Test"], { cwd: repo })
    await writeFile(join(repo, "README.md"), "base\n")
    await exec("git", ["add", "README.md"], { cwd: repo })
    await exec("git", ["commit", "-qm", "initial"], { cwd: repo })

    const session = await sm.createSession({
      provider: "mock",
      cwd: repo,
      title: "Isolated review",
      worktree: true,
    })
    expect(session.baseCwd).toBe(await realpath(repo))
    expect(session.worktreePath).toBe(session.cwd)
    expect(session.branch).toMatch(/^chathub\/isolated-review-/)
    expect(await readFile(join(session.cwd, "README.md"), "utf8")).toBe("base\n")

    await sm.deleteSession(session.id)
    await expect(readFile(session.cwd)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("message attachments", () => {
  it("persists main-derived references without embedding file bytes", async () => {
    const { sm, dir, persistence } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    const image = join(dir, "screen.png")
    await writeFile(image, Buffer.alloc(2048, 7))

    await sm.sendMessage(session.id, "Review this", { attachments: [image] })

    const message = sm.getMessages(session.id).find((item) => item.role === "user")
    expect(message).toMatchObject({
      content: "Review this",
      attachments: [{
        path: image,
        name: "screen.png",
        sizeBytes: 2048,
        kind: "image",
        mime: "image/png",
      }],
    })

    await sm.flush()
    const saved = await persistence.load()
    expect(saved.messages[session.id]?.[0]?.attachments).toEqual(message?.attachments)
    const serialized = JSON.stringify(saved)
    expect(serialized).not.toContain("data:image")
    expect(serialized).not.toContain(Buffer.alloc(24, 7).toString("base64"))
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

describe("waiting_input from pendingInputs", () => {
  function wireBroker(
    sm: InstanceType<typeof SessionManager>,
    bus: EventBus,
    sessionId: string,
  ) {
    const broker = new PermissionBroker(
      bus,
      () => sessionId,
      join(tmpdir(), `island-${Math.random()}.sock`),
      join(tmpdir(), `hub-${Math.random()}.sock`),
    )
    sm.setPermissionBroker(broker)
    return broker
  }

  function ask(
    broker: InstanceType<typeof PermissionBroker>,
    sessionId: string,
    requestId: string,
  ) {
    return broker.requestInputFromAdapter({
      requestId,
      sessionId,
      source: "codex",
      questions: [{ id: "q1", header: "Q", prompt: "say?" }],
    })
  }

  it("opens waiting_input when an Ask-mode input is pending", async () => {
    const { sm, dir, bus } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    const broker = wireBroker(sm, bus, session.id)

    void sm.sendMessage(session.id, "go")
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("running"))

    void ask(broker, session.id, "in-1")
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("waiting_input"),
    )
  })

  it("returns to running when the last input closes while a turn is live", async () => {
    const { sm, dir, bus } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    const broker = wireBroker(sm, bus, session.id)

    void sm.sendMessage(session.id, "go")
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("running"))
    void ask(broker, session.id, "in-1")
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("waiting_input"),
    )

    expect(broker.resolveInput("in-1", { q1: ["ok"] })).toBe(true)
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("running"),
    )

    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
  })

  it("returns to idle when the last input closes and no turn is live", async () => {
    const { sm, dir, bus } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    const broker = wireBroker(sm, bus, session.id)

    // Input without a live turn (e.g. residual / race): still waiting_input.
    void ask(broker, session.id, "in-idle")
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("waiting_input"),
    )
    broker.resolveInput("in-idle", { q1: ["x"] })
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
  })

  it("stays waiting_input until every pending input is closed", async () => {
    const { sm, dir, bus } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    const broker = wireBroker(sm, bus, session.id)

    void sm.sendMessage(session.id, "go")
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("running"))
    void ask(broker, session.id, "a")
    void ask(broker, session.id, "b")
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("waiting_input"),
    )

    broker.resolveInput("a", { q1: ["1"] })
    expect(sm.getSession(session.id)?.status).toBe("waiting_input")

    broker.resolveInput("b", { q1: ["2"] })
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("running"),
    )
    state.pending?.resolve()
  })
})

describe("message archive overflow", () => {
  async function fillAndResolve(
    sm: InstanceType<typeof SessionManager>,
    sessionId: string,
    texts: string[],
  ) {
    for (const text of texts) {
      await sm.sendMessage(sessionId, text)
      state.pending?.resolve()
      await vi.waitFor(() => expect(sm.getSession(sessionId)?.status).toBe("idle"))
    }
  }

  it("spills the oldest message into archive instead of dropping it", async () => {
    // Cap=5 so we do not need 200 real turns to exercise overflow.
    const { sm, dir } = await makeManager(undefined, { maxMessages: 5 })
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await fillAndResolve(
      sm,
      session.id,
      Array.from({ length: 8 }, (_, i) => `msg-${i}`),
    )

    const live = sm.getMessages(session.id)
    expect(live).toHaveLength(5)
    expect(sm.hasArchivedMessages(session.id)).toBe(true)

    await vi.waitFor(async () => {
      const page = await sm.loadArchivedMessages(session.id, live[0]!.id, 50)
      expect(page.messages.length).toBe(3)
    })

    const page = await sm.loadArchivedMessages(session.id, live[0]!.id, 50)
    expect(page.messages.map((m) => m.content)).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
    ])
    expect(live[0]!.content).toBe("msg-3")
  })

  it("appends further overflow without rewriting the archive", async () => {
    const { sm, dir } = await makeManager(undefined, { maxMessages: 3 })
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await fillAndResolve(sm, session.id, ["a", "b", "c", "d"])
    await vi.waitFor(() => expect(sm.hasArchivedMessages(session.id)).toBe(true))
    await fillAndResolve(sm, session.id, ["e", "f"])

    const page = await sm.loadArchivedMessages(session.id, null, 200)
    expect(page.messages.map((m) => m.content)).toEqual(["a", "b", "c"])
    // "a" appears once — second overflow appended, did not rewrite from scratch.
    expect(page.messages.filter((m) => m.content === "a")).toHaveLength(1)
    expect(sm.getMessages(session.id).map((m) => m.content)).toEqual([
      "d",
      "e",
      "f",
    ])
  })

  it("keeps the production default cap at 200", () => {
    expect(MAX_MESSAGES_PER_SESSION).toBe(200)
  })

  it("re-reports the archive after a restart so scroll-back stays reachable", async () => {
    const { sm, dir, persistence } = await makeManager(undefined, {
      maxMessages: 3,
    })
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await fillAndResolve(sm, session.id, ["a", "b", "c", "d"])
    await vi.waitFor(() => expect(sm.hasArchivedMessages(session.id)).toBe(true))
    await sm.flush()

    const restarted = new SessionManager(
      new EventBus(),
      persistence,
      new SessionMonitorBridge(join(dir, "events.jsonl")),
      { handle: () => {} } as unknown as NotificationService,
      new SettingsStore(join(dir, "settings.json")),
      { intervalMs: 60_000, silenceMs: 60_000 },
      { maxMessages: 3, archive: MessageArchive.fromStatePath(persistence.filePath) },
    )
    await restarted.init()

    expect(restarted.hasArchivedMessages(session.id)).toBe(true)
    const page = await restarted.loadArchivedMessages(session.id, null, 200)
    expect(page.messages.map((m) => m.content)).toEqual(["a"])
  })

  it("takes the archive with the session when it is deleted", async () => {
    const { sm, dir } = await makeManager(undefined, { maxMessages: 3 })
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await fillAndResolve(sm, session.id, ["a", "b", "c", "d"])
    await vi.waitFor(() => expect(sm.hasArchivedMessages(session.id)).toBe(true))

    const archiveFile = MessageArchive.fromStatePath(
      join(dir, "state.json"),
    ).fileFor(session.id)
    expect(existsSync(archiveFile)).toBe(true)

    await sm.deleteSession(session.id)
    expect(existsSync(archiveFile)).toBe(false)
    expect(sm.hasArchivedMessages(session.id)).toBe(false)
  })

  it("finds a spilled message that the live window no longer holds", async () => {
    const { sm, dir } = await makeManager(undefined, { maxMessages: 3 })
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await fillAndResolve(sm, session.id, [
      "the zeppelin deploy script",
      "b",
      "c",
      "d",
      "e",
    ])
    await vi.waitFor(() => expect(sm.hasArchivedMessages(session.id)).toBe(true))

    const live = sm.getMessages(session.id)
    expect(live.some((m) => m.content.includes("zeppelin"))).toBe(false)

    const found = await sm.searchArchivedTranscripts("zeppelin", {
      [session.id]: live[0]!.id,
    })
    expect(found.truncated).toBe(false)
    expect(found.hits).toHaveLength(1)
    expect(found.hits[0]?.sessionId).toBe(session.id)

    const hitId = found.hits[0]!.messageId
    const page = await sm.loadArchiveThrough(session.id, live[0]!.id, hitId)
    expect(page.reachedTarget).toBe(true)
    expect(page.messages.some((m) => m.id === hitId)).toBe(true)
  })

  it("reports nothing for a query no archived transcript contains", async () => {
    const { sm, dir } = await makeManager(undefined, { maxMessages: 3 })
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await fillAndResolve(sm, session.id, ["a", "b", "c", "d"])
    await vi.waitFor(() => expect(sm.hasArchivedMessages(session.id)).toBe(true))

    const found = await sm.searchArchivedTranscripts("kubernetes", {})
    expect(found).toEqual({ hits: [], truncated: false })
  })

  it("refuses a session id that would escape the archive root", () => {
    const archive = MessageArchive.fromStatePath("/tmp/whatever/state.json")
    expect(() => archive.fileFor("../../etc")).toThrow(/Invalid session id/)
    expect(() => archive.fileFor("")).toThrow(/Invalid session id/)
  })
})

function restart(
  dir: string,
  persistence: InstanceType<typeof Persistence>,
) {
  const bus = new EventBus()
  const events: HubEvent[] = []
  bus.on((e) => events.push(e))
  const restarted = new SessionManager(
    bus,
    persistence,
    new SessionMonitorBridge(join(dir, "events.jsonl")),
    { handle: () => {} } as unknown as NotificationService,
    new SettingsStore(join(dir, "settings.json")),
    { intervalMs: 60_000, silenceMs: 60_000 },
    { titleGenerator: async () => null },
  )
  return { restarted, events }
}

describe("adapter restore on restart", () => {
  it("publishes restored sessions before the adapters finish re-registering", async () => {
    const { sm, dir, persistence } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.flush()

    let releaseStart = () => {}
    state.startDelay = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const { restarted, events } = restart(dir, persistence)
    await restarted.init()

    expect(restarted.getSession(session.id)).toBeDefined()
    expect(
      events.some(
        (e) => e.type === "sessions.replaced" && e.sessions.length === 1,
      ),
    ).toBe(true)
    releaseStart()
  })

  it("holds a send until the restored adapter is ready", async () => {
    const { sm, dir, persistence } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.flush()

    let releaseStart = () => {}
    state.startDelay = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const { restarted } = restart(dir, persistence)
    await restarted.init()

    const send = restarted.sendMessage(session.id, "after restart")
    expect(state.sent).toEqual([])
    state.startDelay = null
    releaseStart()
    await send
    expect(state.sent).toEqual(["after restart"])
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(restarted.getSession(session.id)?.status).toBe("idle"),
    )
  })

  it("lets a new session send while another session's restore is stuck", async () => {
    const { sm, dir, persistence } = await makeManager()
    const stuck = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.flush()

    let releaseStart = () => {}
    state.startDelay = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const { restarted } = restart(dir, persistence)
    await restarted.init()

    state.startDelay = null
    const fresh = await restarted.createSession({ provider: "mock", cwd: dir })
    await restarted.sendMessage(fresh.id, "fresh session speaks")
    expect(state.sent).toEqual(["fresh session speaks"])
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(restarted.getSession(fresh.id)?.status).toBe("idle"),
    )

    const gated = restarted.sendMessage(stuck.id, "still gated")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(state.sent).toEqual(["fresh session speaks"])
    releaseStart()
    await gated
    expect(state.sent).toEqual(["fresh session speaks", "still gated"])
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(restarted.getSession(stuck.id)?.status).toBe("idle"),
    )
  })
})

describe("browser MCP registration", () => {
  it("registers once at creation and not again on the first send", async () => {
    const { sm, dir } = await makeManager()
    const registered: string[] = []
    sm.setBrowserMcpRegistrar(async (target) => {
      registered.push(target.id)
    })
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    expect(registered).toEqual([session.id])

    await sm.sendMessage(session.id, "hello")
    expect(registered).toEqual([session.id])
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("idle"),
    )
  })

  it("never rewrites workspace configs from the boot-time restore", async () => {
    const { sm, dir, persistence } = await makeManager()
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.flush()

    const { restarted } = restart(dir, persistence)
    const registered: string[] = []
    restarted.setBrowserMcpRegistrar(async (target) => {
      registered.push(target.id)
    })
    await restarted.init()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(registered).toEqual([])

    await restarted.sendMessage(session.id, "after restart")
    expect(registered).toEqual([session.id])
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(restarted.getSession(session.id)?.status).toBe("idle"),
    )

    await restarted.sendMessage(session.id, "again")
    expect(registered).toEqual([session.id])
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(restarted.getSession(session.id)?.status).toBe("idle"),
    )
  })

  it("retries registration on the next send after a failure", async () => {
    const { sm, dir } = await makeManager()
    let fail = true
    const registered: string[] = []
    sm.setBrowserMcpRegistrar(async (target) => {
      if (fail) throw new Error("materialize failed")
      registered.push(target.id)
    })
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    expect(registered).toEqual([])

    fail = false
    await sm.sendMessage(session.id, "first")
    expect(registered).toEqual([session.id])
    state.pending?.resolve()
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("idle"),
    )
  })
})

describe("workspace configs the CLI needs", () => {
  async function repoWithMcpJson(ignored: boolean): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "chat-hub-sm-mcp-"))
    await exec("git", ["init", "-q"], { cwd: repo })
    if (ignored) await writeFile(join(repo, ".gitignore"), "/.mcp.json\n")
    await writeFile(join(repo, ".mcp.json"), '{"mcpServers":{}}\n')
    return repo
  }

  it("tells the new session its workspace carries an unignored CLI config", async () => {
    const { sm } = await makeManager()
    const repo = await repoWithMcpJson(false)

    const session = await sm.createSession({ provider: "mock", cwd: repo })

    await vi.waitFor(() => {
      const notes = sm
        .getMessages(session.id)
        .filter((m) => m.role === "system" && m.content.includes(".mcp.json"))
      expect(notes).toHaveLength(1)
    })
  })

  it("stays quiet when the project already ignores it", async () => {
    const { sm } = await makeManager()
    const repo = await repoWithMcpJson(true)

    const session = await sm.createSession({ provider: "mock", cwd: repo })
    await new Promise((r) => setTimeout(r, 60))

    expect(
      sm.getMessages(session.id).filter((m) => m.role === "system"),
    ).toHaveLength(0)
  })

  it("stays quiet outside a repository, where nothing can be committed", async () => {
    const { sm, dir } = await makeManager()
    await writeFile(join(dir, ".mcp.json"), '{"mcpServers":{}}\n')

    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await new Promise((r) => setTimeout(r, 60))

    expect(
      sm.getMessages(session.id).filter((m) => m.role === "system"),
    ).toHaveLength(0)
  })
})
