import { execFile } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AdapterCallbacks, AdapterStartOpts } from "../src/main/adapters/types"
import type { NotificationService } from "../src/main/notifications"
import {
  createCheckpoint,
  deleteSessionCheckpoints,
  listCheckpoints,
  pruneCheckpoints,
  revertToCheckpoint,
} from "../src/main/checkpoints"

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}))

const { adapter, state } = vi.hoisted(() => {
  const state = {
    pending: null as { resolve: () => void; reject: (err: unknown) => void } | null,
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

const exec = promisify(execFile)

const SID = "11111111-2222-3333-4444-555555555555"

async function makeRepo(commit = true): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "chat-hub-checkpoint-repo-"))
  await exec("git", ["init", "-q"], { cwd: repo })
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo })
  await exec("git", ["config", "user.name", "Chat Hub Test"], { cwd: repo })
  await writeFile(join(repo, "a.txt"), "one\n")
  if (commit) {
    await exec("git", ["add", "a.txt"], { cwd: repo })
    await exec("git", ["commit", "-qm", "initial"], { cwd: repo })
  }
  return repo
}

async function porcelain(repo: string): Promise<string> {
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: repo })
  return stdout
}

beforeEach(() => {
  state.pending = null
})

describe("checkpoints core", () => {
  it("snapshots the working tree without dirtying index or worktree", async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, "a.txt"), "two\n")
    await writeFile(join(repo, "untracked.txt"), "new\n")
    const before = await porcelain(repo)

    const checkpoint = await createCheckpoint(repo, SID, "first turn")
    expect(checkpoint).not.toBeNull()
    expect(checkpoint!.ref).toBe(`refs/chathub/checkpoints/${SID}/1`)
    expect(checkpoint!.label).toBe("first turn")

    expect(await porcelain(repo)).toBe(before)
    const { stdout: staged } = await exec("git", ["diff", "--cached", "--name-only"], {
      cwd: repo,
    })
    expect(staged.trim()).toBe("")

    const { stdout: shown } = await exec(
      "git",
      ["show", `${checkpoint!.ref}:untracked.txt`],
      { cwd: repo },
    )
    expect(shown).toBe("new\n")

    const listed = await listCheckpoints(repo, SID)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ ref: checkpoint!.ref, label: "first turn" })
  })

  it("reverts modified files and deletes files created after the snapshot", async () => {
    const repo = await makeRepo()
    await writeFile(join(repo, "b.txt"), "kept\n")
    const checkpoint = await createCheckpoint(repo, SID, "before turn")

    await writeFile(join(repo, "a.txt"), "agent rewrote this\n")
    await writeFile(join(repo, "b.txt"), "agent rewrote this too\n")
    await mkdir(join(repo, "src"))
    await writeFile(join(repo, "src", "created.ts"), "agent made this\n")

    await revertToCheckpoint(repo, SID, checkpoint!.ref)

    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("one\n")
    expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("kept\n")
    expect(existsSync(join(repo, "src", "created.ts"))).toBe(false)
  })

  it("never touches a file outside the repo root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "chat-hub-checkpoint-outside-"))
    await writeFile(join(outside, "precious.txt"), "do not delete\n")
    const repo = await makeRepo()
    const checkpoint = await createCheckpoint(repo, SID, "clean")

    await symlink(join(outside, "precious.txt"), join(repo, "escape-link"))
    await revertToCheckpoint(repo, SID, checkpoint!.ref)

    expect(await readFile(join(outside, "precious.txt"), "utf8")).toBe(
      "do not delete\n",
    )
  })

  it("refuses a ref that does not belong to the session", async () => {
    const repo = await makeRepo()
    await createCheckpoint(repo, SID, "mine")
    await expect(
      revertToCheckpoint(repo, SID, "refs/heads/main"),
    ).rejects.toThrow(/not a checkpoint/i)
    await expect(
      revertToCheckpoint(repo, SID, `refs/chathub/checkpoints/${SID}/../1`),
    ).rejects.toThrow(/not a checkpoint/i)
  })

  it("snapshots and reverts in a repo with no commits yet", async () => {
    const repo = await makeRepo(false)
    const checkpoint = await createCheckpoint(repo, SID, "pre-commit")
    expect(checkpoint).not.toBeNull()

    await writeFile(join(repo, "a.txt"), "changed\n")
    await writeFile(join(repo, "extra.txt"), "extra\n")
    await revertToCheckpoint(repo, SID, checkpoint!.ref)

    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("one\n")
    expect(existsSync(join(repo, "extra.txt"))).toBe(false)
  })

  it("degrades to unavailable outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-checkpoint-plain-"))
    process.env.GIT_CEILING_DIRECTORIES = dir
    try {
      expect(await createCheckpoint(dir, SID, "nope")).toBeNull()
      expect(await listCheckpoints(dir, SID)).toEqual([])
      await expect(deleteSessionCheckpoints(dir, SID)).resolves.toBeUndefined()
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES
    }
  })

  it("prunes down to the newest 20 refs", { timeout: 60_000 }, async () => {
    const repo = await makeRepo()
    for (let i = 1; i <= 23; i++) {
      await writeFile(join(repo, "a.txt"), `edit ${i}\n`)
      await createCheckpoint(repo, SID, `turn ${i}`)
    }
    await pruneCheckpoints(repo, SID, 20)

    const listed = await listCheckpoints(repo, SID)
    expect(listed).toHaveLength(20)
    expect(listed[0]!.ref.endsWith("/4")).toBe(true)
    expect(listed[19]!.ref.endsWith("/23")).toBe(true)
  })

  it("clears every ref when the session is deleted", async () => {
    const repo = await makeRepo()
    await createCheckpoint(repo, SID, "one")
    await createCheckpoint(repo, SID, "two")
    await deleteSessionCheckpoints(repo, SID)
    expect(await listCheckpoints(repo, SID)).toEqual([])
  })
})

describe("session-manager checkpoints", () => {
  async function makeManager() {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-checkpoint-sm-"))
    const persistence = new Persistence(join(dir, "state.json"))
    const settings = new SettingsStore(join(dir, "settings.json"))
    await settings.load()
    const notifications = { handle: () => {} } as unknown as NotificationService
    const bus = new EventBus()
    const sm = new SessionManager(
      bus,
      persistence,
      new SessionMonitorBridge(join(dir, "events.jsonl")),
      notifications,
      settings,
      { intervalMs: 60_000, silenceMs: 60_000 },
    )
    await sm.init()
    return sm
  }

  it("refuses to revert while a turn is running", async () => {
    const sm = await makeManager()
    const repo = await makeRepo()
    const session = await sm.createSession({ provider: "mock", cwd: repo })
    await sm.sendMessage(session.id, "keep running")

    await expect(
      sm.revertToCheckpoint(session.id, `refs/chathub/checkpoints/x/1`),
    ).rejects.toThrow(/running/i)

    state.pending?.resolve()
  })

  it("stamps a checkpointRef on the user message and truncates on revert", { timeout: 30_000 }, async () => {
    const sm = await makeManager()
    const repo = await makeRepo()
    const session = await sm.createSession({ provider: "mock", cwd: repo })

    await sm.sendMessage(session.id, "first turn")
    state.pending?.resolve()
    await vi.waitFor(
      () => {
        expect(sm.getMessages(session.id)[0]?.checkpointRef).toBeTruthy()
      },
      { timeout: 10_000 },
    )
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("idle"),
    )

    await writeFile(join(repo, "a.txt"), "changed by first turn\n")
    await sm.sendMessage(session.id, "second turn")
    state.pending?.resolve()
    await vi.waitFor(
      () => {
        const stamped = sm
          .getMessages(session.id)
          .filter((m) => m.role === "user")[1]
        expect(stamped?.checkpointRef).toBeTruthy()
      },
      { timeout: 10_000 },
    )
    await vi.waitFor(() =>
      expect(sm.getSession(session.id)?.status).toBe("idle"),
    )

    const secondUser = sm
      .getMessages(session.id)
      .filter((m) => m.role === "user")[1]!
    await writeFile(join(repo, "a.txt"), "changed by second turn\n")

    await sm.revertToCheckpoint(session.id, secondUser.checkpointRef!)

    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe(
      "changed by first turn\n",
    )
    const remaining = sm.getMessages(session.id)
    expect(remaining.some((m) => m.id === secondUser.id)).toBe(false)
    expect(remaining.filter((m) => m.role === "user")).toHaveLength(1)
  })
})
