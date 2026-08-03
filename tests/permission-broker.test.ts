import { connect, createServer, type Server, type Socket } from "node:net"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { HubEvent } from "../src/shared/types"
import { EventBus } from "../src/main/event-bus"
import { PermissionBroker } from "../src/main/permission-broker"

/**
 * The island half of the contract, reduced to what a test can assert:
 * remember every request line, answer on demand, and notice a hang-up.
 */
class FakeIsland {
  readonly requests: Record<string, unknown>[] = []
  private server: Server | null = null
  private held: Socket[] = []
  closed = 0

  async start(path: string): Promise<void> {
    const server = createServer((socket) => {
      this.held.push(socket)
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => {
        for (const line of chunk.split("\n").filter(Boolean)) {
          this.requests.push(JSON.parse(line) as Record<string, unknown>)
        }
      })
      socket.on("close", () => {
        this.closed += 1
      })
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    this.server = server
  }

  answer(behavior: "allow" | "deny"): void {
    for (const socket of this.held) {
      socket.write(`${JSON.stringify({ decision: { behavior } })}\n`)
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.held) socket.destroy()
    this.held = []
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
    this.server = null
  }
}

/** Stand-in for agent-desktop-claude-hook.py's ask_permission_socket(). */
class FakeHook {
  private socket: Socket | null = null
  decision: string | null = null
  ended = false

  async ask(path: string, request: Record<string, unknown>): Promise<void> {
    const socket = connect(path)
    this.socket = socket
    socket.setEncoding("utf8")
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
    socket.write(`${JSON.stringify(request)}\n`)
    socket.on("data", (chunk: string) => {
      const line = chunk.split("\n")[0]
      this.decision =
        (JSON.parse(line) as { decision?: { behavior?: string } }).decision
          ?.behavior ?? null
    })
    socket.on("close", () => {
      this.ended = true
    })
  }

  /** Claude was killed / the terminal closed while the request was pending. */
  die(): void {
    this.socket?.destroy()
  }
}

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

async function harness(opts: { island?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hub-perm-"))
  const islandPath = join(dir, "monitor.sock")
  const hubPath = join(dir, "hub.sock")

  const island = new FakeIsland()
  if (opts.island !== false) {
    await island.start(islandPath)
    cleanup.push(() => island.stop())
  }

  const bus = new EventBus()
  const events: HubEvent[] = []
  bus.on((e) => events.push(e))

  const broker = new PermissionBroker(
    bus,
    (agentSessionId) =>
      agentSessionId === "claude-abc" ? "hub-session-1" : null,
    islandPath,
    hubPath,
  )
  await broker.start()
  cleanup.push(() => broker.stop())

  return { broker, bus, events, island, hubPath }
}

const REQUEST = {
  v: 1,
  source: "claude",
  event: "PermissionRequest",
  sessionId: "claude-abc",
  requestId: "claude-toolu_01",
  summary: "Bash(npm test)",
  payload: { tool_name: "Bash", cwd: "/repo" },
}

describe("unified permission approvals", () => {
  it("routes a native app-server approval through the same Hub card", async () => {
    const { broker, events } = await harness({ island: false })
    const decision = broker.requestFromAdapter({
      requestId: "codex-rpc-7",
      sessionId: "hub-session-1",
      agentSessionId: "codex-thread-1",
      source: "codex",
      summary: "npm test",
      toolName: "Command",
      cwd: "/repo",
    })

    expect(broker.list()).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({
      type: "permission.request",
      request: { requestId: "codex-rpc-7", source: "codex" },
    })
    expect(broker.resolve("codex-rpc-7", "allow")).toBe(true)
    await expect(decision).resolves.toBe("allow")
  })

  it("surfaces the request in the Hub and mirrors it onto the island verbatim", async () => {
    const { events, island, hubPath, broker } = await harness()
    const hook = new FakeHook()
    await hook.ask(hubPath, REQUEST)

    await vi.waitFor(() => expect(island.requests).toHaveLength(1))
    // Rewriting either id would give the island two cards for one tool call:
    // its own JSONL copy from the hook plus ours.
    expect(island.requests[0]).toEqual(REQUEST)

    const surfaced = events.find((e) => e.type === "permission.request")
    expect(surfaced).toMatchObject({
      request: {
        requestId: "claude-toolu_01",
        sessionId: "hub-session-1",
        summary: "Bash(npm test)",
        toolName: "Bash",
        cwd: "/repo",
      },
    })
    expect(broker.list()).toHaveLength(1)
  })

  it("lets the island answer a Hub session's request", async () => {
    const { events, island, hubPath, broker } = await harness()
    const hook = new FakeHook()
    await hook.ask(hubPath, REQUEST)
    await vi.waitFor(() => expect(island.requests).toHaveLength(1))

    island.answer("allow")

    await vi.waitFor(() => expect(hook.decision).toBe("allow"))
    expect(broker.list()).toEqual([])
    expect(events.at(-1)).toMatchObject({
      type: "permission.resolved",
      outcome: "allow",
      decidedBy: "island",
    })
  })

  it("answers from the Hub and hangs up so the island withdraws its card", async () => {
    const { events, island, hubPath, broker } = await harness()
    const hook = new FakeHook()
    await hook.ask(hubPath, REQUEST)
    await vi.waitFor(() => expect(island.requests).toHaveLength(1))

    expect(broker.resolve("claude-toolu_01", "deny")).toBe(true)

    await vi.waitFor(() => expect(hook.decision).toBe("deny"))
    // EOF is the only signal the island has that somebody else decided.
    await vi.waitFor(() => expect(island.closed).toBe(1))
    expect(events.at(-1)).toMatchObject({
      type: "permission.resolved",
      outcome: "deny",
      decidedBy: "hub",
    })
    expect(broker.resolve("claude-toolu_01", "allow")).toBe(false)
  })

  it("still owns the decision when the island is not running", async () => {
    const { hubPath, broker } = await harness({ island: false })
    const hook = new FakeHook()
    await hook.ask(hubPath, REQUEST)

    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))
    expect(broker.resolve("claude-toolu_01", "allow")).toBe(true)
    await vi.waitFor(() => expect(hook.decision).toBe("allow"))
  })

  it("withdraws the card when the asking CLI dies mid-request", async () => {
    const { events, hubPath, broker } = await harness()
    const hook = new FakeHook()
    await hook.ask(hubPath, REQUEST)
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))

    hook.die()

    await vi.waitFor(() => expect(broker.list()).toEqual([]))
    expect(events.at(-1)).toMatchObject({
      type: "permission.resolved",
      outcome: "cancelled",
      decidedBy: "gone",
    })
  })

  it("acks a plain SessionEvent line instead of leaving its sender blocked", async () => {
    const { hubPath, broker } = await harness()
    const hook = new FakeHook()
    await hook.ask(hubPath, {
      type: "session.upsert",
      session: { id: "opencode-1", provider: "opencode" },
    })

    await vi.waitFor(() => expect(hook.ended).toBe(true))
    expect(broker.list()).toEqual([])
  })

  it("drops the request of a session that is being deleted", async () => {
    const { hubPath, broker } = await harness()
    const hook = new FakeHook()
    await hook.ask(hubPath, REQUEST)
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1))

    broker.cancelForSession("hub-session-1")

    expect(broker.list()).toEqual([])
    await vi.waitFor(() => expect(hook.ended).toBe(true))
  })
})
