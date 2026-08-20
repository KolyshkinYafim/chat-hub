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
  type BrowserRequest,
  type BrowserResponse,
} from "@shared/browser"
import { SURFACE_OP_PREFIX, SURFACE_OPS } from "@shared/surface-control"
import { SURFACE_KINDS } from "@shared/surfaces"

const SERVER_SCRIPT = fileURLToPath(
  new URL("../resources/mcp/browser-mcp.mjs", import.meta.url),
)

const SESSION_ID = "session-under-test"

const DOCK_UNREACHABLE =
  "Chat Hub is not reachable, so its panels cannot be opened from here."

type JsonRpcMessage = {
  id?: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

type ToolResult = { content: Array<Record<string, unknown>>; isError?: boolean }

type ToolSpec = {
  name: string
  description: string
  inputSchema: {
    type: string
    properties?: Record<string, { enum?: string[] }>
    required?: string[]
  }
}

type FakeHub = {
  socketPath: string
  requests: BrowserRequest[]
  stop: () => Promise<void>
}

async function startFakeHub(
  respond: (req: BrowserRequest) => BrowserResponse,
): Promise<FakeHub> {
  const dir = await mkdtemp(join(tmpdir(), "chathub-surface-sock-"))
  const socketPath = join(dir, "browser.sock")
  const requests: BrowserRequest[] = []
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
        const request = JSON.parse(line) as BrowserRequest
        requests.push(request)
        if (!socket.destroyed) {
          socket.write(`${JSON.stringify(respond(request))}\n`)
        }
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
  request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<JsonRpcMessage>
  stop: () => Promise<void>
}

function startMcpServer(env: Record<string, string> = {}): McpClient {
  const child: ChildProcess = spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const waiters = new Map<number, (m: JsonRpcMessage) => void>()
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
      const message = JSON.parse(line) as JsonRpcMessage
      const waiter =
        typeof message.id === "number" ? waiters.get(message.id) : undefined
      if (waiter && typeof message.id === "number") {
        waiters.delete(message.id)
        waiter(message)
      }
    }
  })
  child.stderr!.resume()

  return {
    request(method, params) {
      const id = nextId++
      const pending = new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id)
          reject(new Error(`no reply for ${method} within 5000 ms`))
        }, 5000)
        waiters.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
      })
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
const hubs: FakeHub[] = []

function track(client: McpClient): McpClient {
  running.push(client)
  return client
}

function trackHub(hub: FakeHub): FakeHub {
  hubs.push(hub)
  return hub
}

afterEach(async () => {
  for (const client of running.splice(0)) await client.stop()
  for (const hub of hubs.splice(0)) await hub.stop()
})

function summarizing(summary: string) {
  return (req: BrowserRequest): BrowserResponse => ({
    id: req.id,
    ok: true,
    result: { summary },
  })
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
  return String(result.content[0]?.text ?? "")
}

async function listTools(client: McpClient): Promise<ToolSpec[]> {
  const message = await client.request("tools/list")
  return (message.result?.tools ?? []) as ToolSpec[]
}

describe("dock tool catalogue", () => {
  it("offers the six dock tools alongside the browser ones", async () => {
    const client = track(startMcpServer())
    const tools = await listTools(client)
    const dock = tools.filter((t) => t.name.startsWith("surface_"))
    expect(dock.map((t) => t.name).sort()).toEqual([
      "surface_board_add",
      "surface_board_check",
      "surface_close",
      "surface_open",
      "surface_run_script",
      "surface_status",
    ])
    for (const tool of dock) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe("object")
      for (const required of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties ?? {})).toContain(required)
      }
    }
  })

  it("offers exactly the surfaces the dock has", async () => {
    const client = track(startMcpServer())
    const tools = await listTools(client)
    const open = tools.find((t) => t.name === "surface_open")!
    expect(open.inputSchema.properties?.surface?.enum).toEqual([...SURFACE_KINDS])
    expect(open.inputSchema.required).toEqual(["surface"])
  })
})

describe("dock tool calls", () => {
  it("carries the session from its environment into every dock request", async () => {
    const hub = trackHub(await startFakeHub(summarizing("Opened the Diff panel.")))
    const client = track(
      startMcpServer({
        [BROWSER_SOCKET_ENV]: hub.socketPath,
        [BROWSER_SESSION_ENV]: SESSION_ID,
      }),
    )
    const result = await callTool(client, "surface_open", {
      surface: "diff",
      path: "src/app.ts",
    })

    expect(hub.requests).toHaveLength(1)
    expect(hub.requests[0]).toMatchObject({
      sessionId: SESSION_ID,
      op: SURFACE_OPS.open,
      params: { surface: "diff", path: "src/app.ts" },
    })
    expect(result.isError).toBeUndefined()
    expect(firstText(result)).toBe("Opened the Diff panel.")
  })

  it("sends each dock tool to its own op", async () => {
    const hub = trackHub(await startFakeHub(summarizing("ok")))
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: hub.socketPath }))

    await callTool(client, "surface_close")
    await callTool(client, "surface_status")
    await callTool(client, "surface_run_script", { script: "dev" })
    await callTool(client, "surface_board_add", { text: "Ship it" })
    await callTool(client, "surface_board_check", { todo: "Ship it", done: false })

    expect(hub.requests.map((r) => r.op)).toEqual([
      SURFACE_OPS.close,
      SURFACE_OPS.status,
      SURFACE_OPS.script,
      SURFACE_OPS.boardAdd,
      SURFACE_OPS.boardCheck,
    ])
    expect(hub.requests[0]!.params).toEqual({})
    expect(hub.requests[4]!.params).toEqual({ todo: "Ship it", done: false })
  })

  it("drops arguments the tool does not declare", async () => {
    const hub = trackHub(await startFakeHub(summarizing("ok")))
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: hub.socketPath }))
    await callTool(client, "surface_board_add", { text: "Ship it", cwd: "/etc" })
    expect(hub.requests[0]!.params).toEqual({ text: "Ship it" })
  })

  it("reports a missing required argument without touching the Hub", async () => {
    const hub = trackHub(await startFakeHub(summarizing("ok")))
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: hub.socketPath }))

    const noSurface = await callTool(client, "surface_open", { path: "src/app.ts" })
    expect(noSurface.isError).toBe(true)
    expect(firstText(noSurface)).toBe('surface_open requires "surface".')

    const noTodo = await callTool(client, "surface_board_check", { done: true })
    expect(firstText(noTodo)).toBe('surface_board_check requires "todo".')
    expect(hub.requests).toHaveLength(0)
  })

  it("passes the Hub's refusal back as an error result, not a JSON-RPC error", async () => {
    const hub = trackHub(
      await startFakeHub((req) => ({
        id: req.id,
        ok: false,
        error: "Path escapes the workspace",
      })),
    )
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: hub.socketPath }))
    const message = await client.request("tools/call", {
      name: "surface_open",
      arguments: { surface: "files", path: "../secrets" },
    })

    expect(message.error).toBeUndefined()
    const result = message.result as unknown as ToolResult
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(
      "surface_open failed: Path escapes the workspace",
    )
  })

  it("tells the agent the panels are unreachable, not the browser", async () => {
    const client = track(startMcpServer())
    const result = await callTool(client, "surface_status")
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(DOCK_UNREACHABLE)
  })
})

describe("dock contract duplication", () => {
  it("mirrors the TypeScript op names and surfaces", async () => {
    const mod = (await import("../resources/mcp/browser-mcp.mjs")) as unknown as
      Record<string, unknown>
    expect(mod.SURFACE_OP_PREFIX).toBe(SURFACE_OP_PREFIX)
    expect(mod.SURFACE_OPS).toEqual({ ...SURFACE_OPS })
    expect(mod.SURFACE_KINDS).toEqual([...SURFACE_KINDS])
  })
})
