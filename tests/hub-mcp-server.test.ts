import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Socket } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  BROWSER_SESSION_ENV,
  BROWSER_SOCKET_ENV,
} from "@shared/browser"
import {
  HUB_MAX_PANES,
  HUB_MCP_SERVER_NAME,
  HUB_OPS,
  HUB_PRESETS,
  HUB_SURFACE_CHOICES,
} from "@shared/hub-control"
import { asText } from "../src/shared/text"

const SERVER_SCRIPT = fileURLToPath(
  new URL("../resources/mcp/hub-mcp.mjs", import.meta.url),
)

const UNREACHABLE =
  "Chat Hub is not reachable, so its windows cannot be driven from here."

const SESSION_ID = "session-under-test"

type JsonRpcMessage = {
  jsonrpc?: string
  id?: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

type ToolResult = {
  content: Array<Record<string, unknown>>
  isError?: boolean
}

type SocketRequest = {
  id: string
  sessionId: string
  op: string
  params: Record<string, unknown>
}

type SocketResponse =
  | { id: string; ok: true; result: Record<string, unknown> }
  | { id: string; ok: false; error: string }

type Respond = (req: SocketRequest) => SocketResponse

type FakeHub = {
  socketPath: string
  requests: SocketRequest[]
  stop: () => Promise<void>
}

async function startFakeHub(respond: Respond): Promise<FakeHub> {
  const dir = await mkdtemp(join(tmpdir(), "chathub-hub-sock-"))
  const socketPath = join(dir, "browser.sock")
  const requests: SocketRequest[] = []
  const live = new Set<Socket>()

  const server = createServer((socket) => {
    live.add(socket)
    socket.setEncoding("utf8")
    let buffer = ""
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf("\n")
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf("\n")
        if (!line.trim()) continue
        const request = JSON.parse(line) as SocketRequest
        requests.push(request)
        const response = respond(request)
        if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`)
      }
    })
    socket.on("error", () => undefined)
  })

  await new Promise<void>((resolve) => server.listen(socketPath, resolve))

  return {
    socketPath,
    requests,
    async stop() {
      for (const socket of live) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

type McpClient = {
  child: ChildProcess
  request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcMessage>
  received: JsonRpcMessage[]
  stop: () => Promise<void>
}

function startMcpServer(env: Record<string, string | undefined> = {}): McpClient {
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const received: JsonRpcMessage[] = []
  const waiters = new Map<number | string, (m: JsonRpcMessage) => void>()
  let buffer = ""
  let nextId = 1

  child.stdout!.setEncoding("utf8")
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf("\n")
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
      if (!line.trim()) continue
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch {
        message = { jsonrpc: undefined }
      }
      received.push(message)
      const key = message.id ?? "null"
      const waiter = waiters.get(key)
      if (waiter) {
        waiters.delete(key)
        waiter(message)
      }
    }
  })
  child.stderr!.setEncoding("utf8")
  child.stderr!.on("data", () => undefined)

  function waitFor(id: number | string): Promise<JsonRpcMessage> {
    const existing = received.find((m) => (m.id ?? "null") === id)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`no reply for ${String(id)} within 5000 ms`))
      }, 5000)
      waiters.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  return {
    child,
    received,
    request(method, params) {
      const id = nextId++
      const pending = waitFor(id)
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      return pending
    },
    async stop() {
      child.stdin!.end()
      child.kill()
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve()
        else child.once("exit", () => resolve())
      })
    },
  }
}

const running: McpClient[] = []
const fakes: FakeHub[] = []

function track(client: McpClient): McpClient {
  running.push(client)
  return client
}

function trackFake(fake: FakeHub): FakeHub {
  fakes.push(fake)
  return fake
}

afterEach(async () => {
  for (const client of running.splice(0)) await client.stop()
  for (const fake of fakes.splice(0)) await fake.stop()
})

function ok(result: Record<string, unknown>): Respond {
  return (req) => ({ id: req.id, ok: true, result })
}

async function callTool(
  client: McpClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const message = await client.request("tools/call", { name, arguments: args })
  return message.result as unknown as ToolResult
}

function firstText(result: ToolResult): string {
  return asText(result.content[0]?.text)
}

describe("hub MCP server handshake", () => {
  it("answers initialize with the hub server's identity", async () => {
    const client = track(startMcpServer())
    const message = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "test", version: "0" },
      capabilities: {},
    })
    expect(message.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: HUB_MCP_SERVER_NAME, version: "1.0.0" },
    })
  })

  it("rejects an unknown method with -32601", async () => {
    const client = track(startMcpServer())
    expect((await client.request("ping")).result).toEqual({})
    const missing = await client.request("resources/list")
    expect(missing.error?.code).toBe(-32601)
  })
})

describe("hub MCP tool catalogue", () => {
  it("lists the six hub tools with object schemas", async () => {
    const client = track(startMcpServer())
    const message = await client.request("tools/list")
    const tools = (message.result?.tools ?? []) as Array<{
      name: string
      description: string
      inputSchema: {
        type: string
        properties?: Record<string, { enum?: string[] }>
        required?: string[]
      }
    }>
    expect(tools.map((t) => t.name).sort()).toEqual([
      "hub_arrange",
      "hub_focus_session",
      "hub_list_windows",
      "hub_open_surface",
      "hub_open_window",
      "hub_set_layout",
    ])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe("object")
      for (const required of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties ?? {})).toContain(required)
      }
    }
    const surface = tools.find((t) => t.name === "hub_open_surface")!
    expect(surface.inputSchema.properties?.surface?.enum).toEqual([
      ...HUB_SURFACE_CHOICES,
    ])
    const arrange = tools.find((t) => t.name === "hub_arrange")!
    expect(arrange.inputSchema.properties?.preset?.enum).toEqual([...HUB_PRESETS])
    const layout = tools.find((t) => t.name === "hub_set_layout")!
    expect(layout.inputSchema.required).toEqual(["windowId", "panes"])
  })
})

describe("hub MCP tool calls", () => {
  it("round-trips a focus through the socket with the session env", async () => {
    const fake = trackFake(
      await startFakeHub(ok({ summary: "Focused the session.", windowId: 1 })),
    )
    const client = track(
      startMcpServer({
        [BROWSER_SOCKET_ENV]: fake.socketPath,
        [BROWSER_SESSION_ENV]: SESSION_ID,
      }),
    )
    const result = await callTool(client, "hub_focus_session", {
      sessionId: "s-9",
      windowId: 2,
    })

    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({
      sessionId: SESSION_ID,
      op: HUB_OPS.focusSession,
      params: { sessionId: "s-9", windowId: 2 },
    })
    expect(result.isError).toBeUndefined()
    expect(firstText(result)).toBe("Focused the session.")
  })

  it("reports a missing required argument without touching the socket", async () => {
    const fake = trackFake(await startFakeHub(ok({})))
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: fake.socketPath }))
    const result = await callTool(client, "hub_set_layout", { windowId: 1 })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe('hub_set_layout requires "panes".')
    expect(fake.requests).toHaveLength(0)
  })

  it("turns a hub refusal into an error result, not a JSON-RPC error", async () => {
    const fake = trackFake(
      await startFakeHub((req) => ({
        id: req.id,
        ok: false,
        error: "No Chat Hub window has the id 7.",
      })),
    )
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: fake.socketPath }))
    const message = await client.request("tools/call", {
      name: "hub_set_layout",
      arguments: { windowId: 7, panes: [{ sessionId: "s-1" }] },
    })

    expect(message.error).toBeUndefined()
    const result = message.result as unknown as ToolResult
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(
      "hub_set_layout failed: No Chat Hub window has the id 7.",
    )
  })

  it("rejects an unknown tool name with -32602", async () => {
    const client = track(startMcpServer())
    const message = await client.request("tools/call", { name: "hub_teleport" })
    expect(message.error?.code).toBe(-32602)
  })

  it("tells the agent the Hub is unreachable when the socket is absent", async () => {
    const client = track(
      startMcpServer({ [BROWSER_SOCKET_ENV]: join(tmpdir(), "chathub-nothing.sock") }),
    )
    const result = await callTool(client, "hub_list_windows")
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(UNREACHABLE)
  })
})

describe("hub MCP duplicated contract", () => {
  it("keeps the copied constants equal to src/shared/hub-control.ts", async () => {
    const mod = (await import("../resources/mcp/hub-mcp.mjs")) as unknown as Record<
      string,
      unknown
    >
    expect(mod.BROWSER_SOCKET_ENV).toBe(BROWSER_SOCKET_ENV)
    expect(mod.BROWSER_SESSION_ENV).toBe(BROWSER_SESSION_ENV)
    expect(mod.HUB_MCP_SERVER_NAME).toBe(HUB_MCP_SERVER_NAME)
    expect(mod.HUB_MAX_PANES).toBe(HUB_MAX_PANES)
    expect(mod.HUB_OPS).toEqual({ ...HUB_OPS })
    expect(mod.HUB_SURFACE_CHOICES).toEqual([...HUB_SURFACE_CHOICES])
    expect(mod.HUB_PRESETS).toEqual([...HUB_PRESETS])
  })
})
