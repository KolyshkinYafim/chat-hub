import { mkdtemp } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import type { TerminalChunk, TerminalExit } from "../src/shared/surfaces"
import {
  TerminalSessions,
  normalizeDimension,
  resolveLoginShell,
  terminalEnv,
} from "../src/main/surfaces/terminal"

const SPAWN_TIMEOUT_MS = 20_000

let root = ""
let sessions: TerminalSessions | null = null

const chunks: TerminalChunk[] = []
const exits: TerminalExit[] = []

function newSessions(): TerminalSessions {
  chunks.length = 0
  exits.length = 0
  sessions = new TerminalSessions({
    data: (chunk) => {
      chunks.push(chunk)
    },
    exit: (event) => {
      exits.push(event)
    },
  })
  return sessions
}

function waitForExit(ptyId: string): Promise<TerminalExit> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + SPAWN_TIMEOUT_MS
    const poll = setInterval(() => {
      const found = exits.find((e) => e.ptyId === ptyId)
      if (found) {
        clearInterval(poll)
        resolve(found)
        return
      }
      if (Date.now() > deadline) {
        clearInterval(poll)
        reject(new Error("pty never exited"))
      }
    }, 25)
  })
}

beforeAll(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "chat-hub-pty-")))
  process.env.SHELL = "/bin/sh"
})

afterEach(() => {
  sessions?.killAll()
  sessions = null
})

describe("terminal size and environment", () => {
  it("clamps and floors renderer-supplied dimensions", () => {
    expect(normalizeDimension(120.9, 80)).toBe(120)
    expect(normalizeDimension(0, 80)).toBe(1)
    expect(normalizeDimension(-5, 80)).toBe(1)
    expect(normalizeDimension(10_000, 80)).toBe(1000)
    expect(normalizeDimension(Number.NaN, 80)).toBe(80)
    expect(normalizeDimension("120", 80)).toBe(80)
    expect(normalizeDimension(undefined, 24)).toBe(24)
  })

  it("hands the shell a terminal-shaped environment", () => {
    process.env.ELECTRON_RUN_AS_NODE = "1"
    const env = terminalEnv()
    expect(env.TERM).toBe("xterm-256color")
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    delete process.env.ELECTRON_RUN_AS_NODE
  })

  it("picks an executable absolute shell", () => {
    expect(resolveLoginShell().startsWith("/")).toBe(true)
  })
})

describe("terminal sessions", () => {
  it("rejects a workspace the renderer made up", async () => {
    const terminals = newSessions()
    await expect(terminals.start(join(root, "nope"), 80, 24)).rejects.toThrow(
      /Workspace not found/,
    )
    await expect(terminals.start(42, 80, 24)).rejects.toThrow(
      /Invalid workspace path/,
    )
    expect(terminals.size).toBe(0)
  })

  it("runs a real shell, streams its output and reports its exit code", async () => {
    const terminals = newSessions()
    const { ptyId } = await terminals.start(root, 80, 24)
    expect(terminals.size).toBe(1)

    expect(terminals.write(ptyId, "exit 3\n")).toBe(true)
    const exit = await waitForExit(ptyId)

    expect(exit.exitCode).toBe(3)
    expect(chunks.some((c) => c.ptyId === ptyId && c.data.length > 0)).toBe(true)
    expect(terminals.size).toBe(0)
  }, SPAWN_TIMEOUT_MS)

  it("forgets a pty once it has exited", async () => {
    const terminals = newSessions()
    const { ptyId } = await terminals.start(root, 80, 24)
    terminals.write(ptyId, "exit 0\n")
    await waitForExit(ptyId)

    expect(terminals.write(ptyId, "echo late\n")).toBe(false)
    expect(terminals.resize(ptyId, 100, 40)).toBe(false)
    expect(terminals.kill(ptyId)).toBe(false)
    expect(exits.filter((e) => e.ptyId === ptyId)).toHaveLength(1)
  }, SPAWN_TIMEOUT_MS)

  it("ignores writes for an unknown pty id", async () => {
    const terminals = newSessions()
    expect(terminals.write("not-a-pty", "rm -rf /\n")).toBe(false)
    expect(terminals.write(null, "x")).toBe(false)
    expect(terminals.resize("not-a-pty", 80, 24)).toBe(false)
    expect(terminals.kill("not-a-pty")).toBe(false)
  })

  it("refuses non-string writes to a live pty", async () => {
    const terminals = newSessions()
    const { ptyId } = await terminals.start(root, 80, 24)
    expect(terminals.write(ptyId, 42)).toBe(false)
    expect(terminals.write(ptyId, "")).toBe(false)
    expect(terminals.resize(ptyId, 120, 40)).toBe(true)
  }, SPAWN_TIMEOUT_MS)

  it("kills every live pty on quit", async () => {
    const terminals = newSessions()
    const first = await terminals.start(root, 80, 24)
    const second = await terminals.start(root, 80, 24)
    expect(terminals.size).toBe(2)

    terminals.killAll()
    expect(terminals.size).toBe(0)
    expect(terminals.write(first.ptyId, "echo\n")).toBe(false)
    expect(terminals.write(second.ptyId, "echo\n")).toBe(false)
  }, SPAWN_TIMEOUT_MS)
})
