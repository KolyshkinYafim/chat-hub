import { appendFile, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { MonitorCommandBridge } from "../src/main/command-bridge"
import type { SessionManager } from "../src/main/session-manager"
import type { SessionMeta } from "@shared/types"

type Calls = {
  active: (string | null)[]
  focused: (string | null)[]
  created: { provider: string; cwd?: string }[]
  sent: { id: string; text: string }[]
}

function fakeManager(known: string[], sessions: SessionMeta[], calls: Calls) {
  return {
    setActiveSession(id: string | null) {
      const ok = id === null || known.includes(id)
      if (ok) calls.active.push(id)
      return ok
    },
    listSessions: () => sessions,
    async createSession(input: { provider: string; cwd?: string }) {
      calls.created.push(input)
      return { id: "new-session" } as SessionMeta
    },
    async sendMessage(id: string, text: string) {
      calls.sent.push({ id, text })
    },
  } as unknown as SessionManager
}

async function bridgeWith(
  lines: unknown[],
  opts: { known?: string[]; sessions?: SessionMeta[] } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-cmd-"))
  const file = join(dir, "commands.jsonl")
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8")
  const calls: Calls = { active: [], focused: [], created: [], sent: [] }
  const bridge = new MonitorCommandBridge(
    fakeManager(opts.known ?? [], opts.sessions ?? [], calls),
    (id) => calls.focused.push(id),
    file,
  )
  return { bridge, calls, file }
}

function session(id: string, cwd: string): SessionMeta {
  return {
    id,
    title: id,
    project: "p",
    provider: "claude",
    cwd,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("cold start", () => {
  it("runs the command that launched the Hub instead of skipping to EOF", async () => {
    const { bridge, calls } = await bridgeWith(
      [{ type: "session.focus", id: "s1", ts: Date.now() }],
      { known: ["s1"] },
    )
    bridge.start()
    bridge.stop()
    expect(calls.active).toEqual(["s1"])
    expect(calls.focused).toEqual(["s1"])
  })

  it("ignores a command left over from an earlier run", async () => {
    const { bridge, calls } = await bridgeWith(
      [{ type: "session.focus", id: "s1", ts: Date.now() - 3_600_000 }],
      { known: ["s1"] },
    )
    bridge.start()
    bridge.stop()
    expect(calls.focused).toEqual([])
  })

  it("resumes after the offset it already consumed", async () => {
    const { bridge, calls, file } = await bridgeWith(
      [{ type: "session.focus", id: "s1", ts: Date.now() }],
      { known: ["s1", "s2"] },
    )
    bridge.start()
    bridge.stop()
    expect(calls.focused).toEqual(["s1"])

    // A second run must not replay s1 — only what was appended since.
    await appendFile(
      file,
      `${JSON.stringify({ type: "session.focus", id: "s2", ts: Date.now() })}\n`,
      "utf8",
    )
    bridge.start()
    bridge.stop()
    expect(calls.focused).toEqual(["s1", "s2"])
  })
})

describe("focus of a session the Hub does not have", () => {
  it("surfaces the window without pointing the renderer at a ghost", async () => {
    const { bridge, calls } = await bridgeWith(
      [{ type: "session.focus", id: "gone", ts: Date.now() }],
      { known: ["s1"] },
    )
    bridge.start()
    bridge.stop()
    expect(calls.active).toEqual([])
    expect(calls.focused).toEqual([null])
  })
})

describe("session.new without a folder", () => {
  it("inherits the most recently used project instead of the process cwd", async () => {
    const { bridge, calls } = await bridgeWith(
      [{ type: "session.new", provider: "claude", ts: Date.now() }],
      { sessions: [session("s1", "/tmp/project-a")] },
    )
    bridge.start()
    bridge.stop()
    await vi.waitFor(() =>
      expect(calls.created).toEqual([
        { provider: "claude", cwd: "/tmp/project-a", title: undefined },
      ]),
    )
  })

  it("creates nothing when there is no folder to inherit", async () => {
    const { bridge, calls } = await bridgeWith([
      { type: "session.new", provider: "claude", ts: Date.now() },
    ])
    bridge.start()
    bridge.stop()
    expect(calls.created).toEqual([])
    expect(calls.focused).toEqual([null])
  })
})
