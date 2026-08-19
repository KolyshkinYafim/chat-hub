import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NotificationService } from "../src/main/notifications"
import type { ScriptExec } from "../src/main/surfaces/scripts"

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}))

const { adapter, worktreeState } = vi.hoisted(() => {
  const worktreeState = { cwd: "", root: "", removed: [] as string[] }
  const adapter = {
    id: "mock" as const,
    available: true,
    async start(): Promise<void> {},
    async send(): Promise<void> {},
    async abort(): Promise<void> {},
    async dispose(): Promise<void> {},
  }
  return { adapter, worktreeState }
})

vi.mock("../src/main/adapters", () => ({
  getAdapter: () => adapter,
  listAdapters: () => [adapter],
  refreshProviders: () => {},
  listProviderInfo: () => [],
}))

vi.mock("../src/main/git", () => ({
  createSessionWorktree: async () => ({
    cwd: worktreeState.cwd,
    root: worktreeState.root,
    branch: "chathub/test",
    path: worktreeState.cwd,
  }),
  removeSessionWorktree: async (_repo: string, path: string) => {
    worktreeState.removed.push(path)
  },
}))

const { runWorktreeCreateScripts } = await import("../src/main/surfaces/scripts")
const { SessionManager } = await import("../src/main/session-manager")
const { EventBus } = await import("../src/main/event-bus")
const { Persistence } = await import("../src/main/persistence")
const { SessionMonitorBridge } = await import("../src/main/bridge")
const { SettingsStore } = await import("../src/main/settings")

let base = ""
let worktree = ""

async function seedScripts(scripts: unknown[]): Promise<void> {
  await mkdir(join(base, ".chathub"), { recursive: true })
  await writeFile(
    join(base, ".chathub", "scripts.json"),
    JSON.stringify({ scripts }, null, 2),
    "utf8",
  )
}

function recordingExec(failFor: string[] = []) {
  const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = []
  const exec: ScriptExec = async (command, cwd, timeoutMs) => {
    calls.push({ command, cwd, timeoutMs })
    return failFor.includes(command)
      ? { ok: false, detail: "exit 1" }
      : { ok: true, detail: "" }
  }
  return { calls, exec }
}

async function makeManager(worktreeSetup?: (b: string, w: string) => Promise<string[]>) {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-scripts-sm-"))
  const persistence = new Persistence(join(dir, "state.json"))
  const settings = new SettingsStore(join(dir, "settings.json"))
  await settings.load()
  const sm = new SessionManager(
    new EventBus(),
    persistence,
    new SessionMonitorBridge(join(dir, "events.jsonl")),
    { handle: () => {} } as unknown as NotificationService,
    settings,
    { intervalMs: 60_000, silenceMs: 60_000 },
    { worktreeSetup },
  )
  await sm.init()
  return sm
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "chat-hub-scripts-base-"))
  worktree = await mkdtemp(join(tmpdir(), "chat-hub-scripts-wt-"))
  worktreeState.cwd = worktree
  worktreeState.root = base
  worktreeState.removed = []
})

describe("runWorktreeCreateScripts", () => {
  it("runs only the flagged scripts, sequentially, in the worktree cwd", async () => {
    await seedScripts([
      { id: "install", name: "Install", command: "pnpm install", runOnWorktreeCreate: true },
      { id: "dev", name: "Dev", command: "pnpm dev" },
      { id: "seed", name: "Seed", command: "pnpm seed", runOnWorktreeCreate: true },
    ])
    const { calls, exec } = recordingExec()

    const notes = await runWorktreeCreateScripts(base, worktree, exec)

    expect(calls.map((c) => c.command)).toEqual(["pnpm install", "pnpm seed"])
    expect(calls.every((c) => c.cwd === worktree)).toBe(true)
    expect(calls.every((c) => c.timeoutMs === 5 * 60_000)).toBe(true)
    expect(notes).toEqual([
      'Worktree setup — "Install" (pnpm install) finished.',
      'Worktree setup — "Seed" (pnpm seed) finished.',
    ])
  })

  it("reports a failed script and keeps running the rest", async () => {
    await seedScripts([
      { id: "a", name: "Broken", command: "pnpm broken", runOnWorktreeCreate: true },
      { id: "b", name: "Fine", command: "pnpm fine", runOnWorktreeCreate: true },
    ])
    const { calls, exec } = recordingExec(["pnpm broken"])

    const notes = await runWorktreeCreateScripts(base, worktree, exec)

    expect(calls).toHaveLength(2)
    expect(notes[0]).toContain('"Broken" (pnpm broken) failed: exit 1')
    expect(notes[1]).toBe('Worktree setup — "Fine" (pnpm fine) finished.')
  })

  it("survives an exec that rejects outright", async () => {
    await seedScripts([
      { id: "a", name: "Boom", command: "pnpm boom", runOnWorktreeCreate: true },
    ])
    const exec: ScriptExec = async () => {
      throw new Error("spawn refused")
    }

    const notes = await runWorktreeCreateScripts(base, worktree, exec)

    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("spawn refused")
  })

  it("does nothing when the project has no scripts file", async () => {
    const { calls, exec } = recordingExec()
    await expect(runWorktreeCreateScripts(base, worktree, exec)).resolves.toEqual([])
    expect(calls).toEqual([])
  })
})

describe("worktree sessions and setup scripts", () => {
  it("runs the flagged script in the worktree and posts the outcome as a system note", async () => {
    await seedScripts([
      { id: "install", name: "Install", command: "pnpm install", runOnWorktreeCreate: true },
    ])
    const { calls, exec } = recordingExec()
    const sm = await makeManager((b, w) => runWorktreeCreateScripts(b, w, exec))

    const session = await sm.createSession({
      provider: "mock",
      cwd: base,
      worktree: true,
    })

    expect(session.cwd).toBe(worktree)
    await vi.waitFor(() => {
      const system = sm.getMessages(session.id).filter((m) => m.role === "system")
      expect(system).toHaveLength(1)
      expect(system[0]?.content).toBe(
        'Worktree setup — "Install" (pnpm install) finished.',
      )
    })
    expect(calls).toEqual([
      { command: "pnpm install", cwd: worktree, timeoutMs: 5 * 60_000 },
    ])
  })

  it("keeps the session alive when a setup script fails", async () => {
    await seedScripts([
      { id: "a", name: "Broken", command: "pnpm broken", runOnWorktreeCreate: true },
    ])
    const { exec } = recordingExec(["pnpm broken"])
    const sm = await makeManager((b, w) => runWorktreeCreateScripts(b, w, exec))

    const session = await sm.createSession({
      provider: "mock",
      cwd: base,
      worktree: true,
    })

    await vi.waitFor(() => {
      const system = sm.getMessages(session.id).filter((m) => m.role === "system")
      expect(system[0]?.content).toContain("failed: exit 1")
    })
    expect(sm.getSession(session.id)?.status).toBe("idle")
    expect(worktreeState.removed).toEqual([])
  })

  it("holds the first turn until the setup finished", async () => {
    await seedScripts([
      { id: "a", name: "Slow", command: "pnpm slow", runOnWorktreeCreate: true },
    ])
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sendSpy = vi.spyOn(adapter, "send")
    const sm = await makeManager(async (b, w) => {
      return runWorktreeCreateScripts(b, w, async () => {
        await gate
        return { ok: true, detail: "" }
      })
    })

    const session = await sm.createSession({
      provider: "mock",
      cwd: base,
      worktree: true,
    })
    await sm.sendMessage(session.id, "start working")

    expect(sendSpy).not.toHaveBeenCalled()
    expect(sm.listQueued(session.id)).toHaveLength(1)

    release?.()
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1))
    expect(sm.listQueued(session.id)).toHaveLength(0)
  })

  it("skips the setup entirely for a plain non-worktree session", async () => {
    await seedScripts([
      { id: "a", name: "Install", command: "pnpm install", runOnWorktreeCreate: true },
    ])
    const { calls, exec } = recordingExec()
    const sm = await makeManager((b, w) => runWorktreeCreateScripts(b, w, exec))

    const session = await sm.createSession({ provider: "mock", cwd: base })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toEqual([])
    expect(sm.getMessages(session.id)).toEqual([])
  })
})
