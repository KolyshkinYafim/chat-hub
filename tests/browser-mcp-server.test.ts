import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Socket } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_MODIFIERS,
  BROWSER_OP_TIMEOUT_MS,
  BROWSER_SESSION_ENV,
  BROWSER_SNAPSHOT_CHAR_LIMIT,
  BROWSER_SOCKET_ENV,
  BROWSER_TEXT_CHAR_LIMIT,
  renderSnapshot,
  type BrowserRequest,
  type BrowserResponse,
  type BrowserSnapshot,
} from "@shared/browser"

const SERVER_SCRIPT = fileURLToPath(
  new URL("../resources/mcp/browser-mcp.mjs", import.meta.url),
)

const UNREACHABLE =
  "Chat Hub's browser surface is not reachable. Open the Browser surface in Chat Hub and retry."

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

type Respond = (req: BrowserRequest) => BrowserResponse | Promise<BrowserResponse>

type FakeBrowser = {
  socketPath: string
  requests: BrowserRequest[]
  stop: () => Promise<void>
}

async function startFakeBrowser(
  respond: Respond,
  atPath?: string,
): Promise<FakeBrowser> {
  const dir = atPath ? null : await mkdtemp(join(tmpdir(), "chathub-browser-sock-"))
  const socketPath = atPath ?? join(dir!, "browser.sock")
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
        void Promise.resolve(respond(request)).then((response) => {
          if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`)
        })
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
      if (dir) await rm(dir, { recursive: true, force: true })
    },
  }
}

type McpClient = {
  child: ChildProcess
  request: (method: string, params?: Record<string, unknown>) => Promise<JsonRpcMessage>
  notify: (method: string, params?: Record<string, unknown>) => void
  writeRaw: (text: string) => void
  waitFor: (id: number | string) => Promise<JsonRpcMessage>
  received: JsonRpcMessage[]
  stdout: () => string
  stderr: () => string
  stop: () => Promise<void>
}

function startMcpServer(env: Record<string, string | undefined> = {}): McpClient {
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const received: JsonRpcMessage[] = []
  const waiters = new Map<number | string, (m: JsonRpcMessage) => void>()
  let raw = ""
  let errors = ""
  let buffer = ""
  let nextId = 1

  child.stdout!.setEncoding("utf8")
  child.stdout!.on("data", (chunk: string) => {
    raw += chunk
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
  child.stderr!.on("data", (chunk: string) => {
    errors += chunk
  })

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
    waitFor,
    writeRaw(text) {
      child.stdin!.write(text)
    },
    notify(method, params) {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
    },
    request(method, params) {
      const id = nextId++
      const pending = waitFor(id)
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      return pending
    },
    stdout: () => raw,
    stderr: () => errors,
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
const fakes: FakeBrowser[] = []

function track(client: McpClient): McpClient {
  running.push(client)
  return client
}

function trackFake(fake: FakeBrowser): FakeBrowser {
  fakes.push(fake)
  return fake
}

afterEach(async () => {
  for (const client of running.splice(0)) await client.stop()
  for (const fake of fakes.splice(0)) await fake.stop()
})

function ok(result: Record<string, unknown>): (req: BrowserRequest) => BrowserResponse {
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
  return String(result.content[0]?.text ?? "")
}

const SAMPLE_SNAPSHOT: BrowserSnapshot = {
  url: "https://example.test/form",
  title: "Sign in",
  truncated: true,
  nodes: [
    { ref: "ref_1", role: "heading", name: "Sign in", depth: 0 },
    { ref: "ref_2", role: "textbox", name: "Email", value: "a@b.c", depth: 1 },
    { ref: "ref_3", role: "checkbox", name: "Remember me", checked: false, depth: 1 },
    { ref: "ref_4", role: "button", name: "Submit", disabled: true, depth: 1 },
  ],
}

describe("browser MCP server handshake", () => {
  it("answers initialize with the tools capability and its server info", async () => {
    const client = track(startMcpServer())
    const message = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "test", version: "0" },
      capabilities: {},
    })
    expect(message.result).toMatchObject({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: BROWSER_MCP_SERVER_NAME, version: "1.0.0" },
    })
  })

  it("echoes a protocol version it recognises and falls back for one it does not", async () => {
    const client = track(startMcpServer())
    const known = await client.request("initialize", { protocolVersion: "2025-06-18" })
    const unknown = await client.request("initialize", { protocolVersion: "1999-01-01" })
    expect(known.result?.protocolVersion).toBe("2025-06-18")
    expect(unknown.result?.protocolVersion).toBe("2024-11-05")
  })

  it("answers ping and rejects an unknown method with -32601", async () => {
    const client = track(startMcpServer())
    expect((await client.request("ping")).result).toEqual({})
    const missing = await client.request("resources/list")
    expect(missing.error?.code).toBe(-32601)
  })

  it("never replies to a notification", async () => {
    const client = track(startMcpServer())
    client.notify("notifications/initialized")
    const pong = await client.request("ping")
    expect(pong.id).toBe(1)
    expect(client.received).toHaveLength(1)
  })
})

describe("browser MCP tool catalogue", () => {
  it("lists all thirteen browser tools with object schemas", async () => {
    const client = track(startMcpServer())
    const message = await client.request("tools/list")
    const tools = (message.result?.tools ?? []) as Array<{
      name: string
      description: string
      inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] }
    }>
    expect(tools.map((t) => t.name).sort()).toEqual([
      "browser_click",
      "browser_console",
      "browser_fill",
      "browser_hover",
      "browser_key",
      "browser_navigate",
      "browser_network",
      "browser_screenshot",
      "browser_scroll",
      "browser_snapshot",
      "browser_text",
      "browser_type",
      "browser_wait",
    ])
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.inputSchema.type).toBe("object")
      expect(tool.inputSchema.properties).toBeTypeOf("object")
      for (const required of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties ?? {})).toContain(required)
      }
    }
    const navigate = tools.find((t) => t.name === "browser_navigate")!
    expect(navigate.inputSchema.required).toEqual(["url"])
    const click = tools.find((t) => t.name === "browser_click")!
    expect(Object.keys(click.inputSchema.properties ?? {})).toEqual([
      "ref",
      "x",
      "y",
      "button",
      "doubleClick",
      "modifiers",
    ])
  })

  it("offers only the contract's modifier keys", async () => {
    const client = track(startMcpServer())
    const message = await client.request("tools/list")
    const tools = (message.result?.tools ?? []) as Array<{
      name: string
      inputSchema: { properties?: Record<string, { items?: { enum?: string[] } }> }
    }>
    const key = tools.find((t) => t.name === "browser_key")!
    expect(key.inputSchema.properties?.modifiers?.items?.enum).toEqual([...BROWSER_MODIFIERS])
  })
})

describe("browser MCP tool calls", () => {
  it("round-trips a navigate through the socket and reports where it landed", async () => {
    const fake = trackFake(
      await startFakeBrowser(ok({ url: "https://example.test/next", title: "Next page" })),
    )
    const client = track(
      startMcpServer({
        [BROWSER_SOCKET_ENV]: fake.socketPath,
        [BROWSER_SESSION_ENV]: SESSION_ID,
      }),
    )
    const result = await callTool(client, "browser_navigate", { url: "https://example.test" })

    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({
      sessionId: SESSION_ID,
      op: "navigate",
      params: { url: "https://example.test" },
    })
    expect(typeof fake.requests[0]!.id).toBe("string")
    expect(result.isError).toBeUndefined()
    expect(firstText(result)).toBe(
      "Navigated — url: https://example.test/next — title: Next page",
    )
  })

  it("renders a snapshot exactly as the shared renderer does", async () => {
    const fake = trackFake(
      await startFakeBrowser(ok(SAMPLE_SNAPSHOT as unknown as Record<string, unknown>)),
    )
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: fake.socketPath }))
    const result = await callTool(client, "browser_snapshot", { filter: "all", limit: 50 })

    expect(fake.requests[0]!.params).toEqual({ filter: "all", limit: 50 })
    expect(firstText(result)).toBe(renderSnapshot(SAMPLE_SNAPSHOT))
  })

  it("returns a screenshot as an image block with bare base64", async () => {
    const fake = trackFake(
      await startFakeBrowser(ok({ data: "data:image/png;base64,QUJD", mimeType: "image/png" })),
    )
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: fake.socketPath }))
    const result = await callTool(client, "browser_screenshot")

    expect(result.content[0]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" })
  })

  it("formats console and network reads as readable lines", async () => {
    const fake = trackFake(
      await startFakeBrowser((req) =>
        req.op === "console"
          ? {
              id: req.id,
              ok: true,
              result: {
                messages: [
                  { level: "error", text: "boom", source: "app.js", line: 12, at: 1 },
                ],
              },
            }
          : {
              id: req.id,
              ok: true,
              result: {
                entries: [
                  {
                    requestId: "1",
                    method: "GET",
                    url: "https://example.test/api",
                    status: 500,
                    mimeType: "application/json",
                    failed: false,
                    at: 1,
                  },
                ],
              },
            },
      ),
    )
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: fake.socketPath }))

    const consoleResult = await callTool(client, "browser_console", { onlyErrors: true })
    expect(firstText(consoleResult)).toBe("[ERROR] boom (app.js:12)")

    const networkResult = await callTool(client, "browser_network", { limit: 5 })
    expect(firstText(networkResult)).toBe(
      "GET https://example.test/api → 500 application/json",
    )
  })

  it("reports a missing required argument without touching the browser", async () => {
    const fake = trackFake(await startFakeBrowser(ok({})))
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: fake.socketPath }))
    const result = await callTool(client, "browser_fill", { ref: "ref_1" })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe('browser_fill requires "value".')
    expect(fake.requests).toHaveLength(0)
  })

  it("asks for a ref or a point when a click has neither", async () => {
    const fake = trackFake(await startFakeBrowser(ok({})))
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: fake.socketPath }))
    const result = await callTool(client, "browser_click", {})

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain("browser_click needs a target")
    expect(fake.requests).toHaveLength(0)
  })

  it("turns a browser failure into an error result, not a JSON-RPC error", async () => {
    const fake = trackFake(
      await startFakeBrowser((req) => ({ id: req.id, ok: false, error: "ref_9 is stale" })),
    )
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: fake.socketPath }))
    const message = await client.request("tools/call", {
      name: "browser_click",
      arguments: { ref: "ref_9" },
    })

    expect(message.error).toBeUndefined()
    const result = message.result as unknown as ToolResult
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe("browser_click failed: ref_9 is stale")
  })

  it("rejects an unknown tool name with -32602", async () => {
    const client = track(startMcpServer())
    const message = await client.request("tools/call", { name: "browser_teleport" })
    expect(message.error?.code).toBe(-32602)
    expect(message.error?.message).toContain("browser_teleport")
  })

  it("tells the agent how to reach the surface when the socket is absent", async () => {
    const client = track(
      startMcpServer({ [BROWSER_SOCKET_ENV]: join(tmpdir(), "chathub-nothing-here.sock") }),
    )
    const result = await callTool(client, "browser_text")
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(UNREACHABLE)
  })

  it("says the same when no socket was handed to it at all", async () => {
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: "" }))
    const result = await callTool(client, "browser_snapshot")
    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe(UNREACHABLE)
  })

  it("reconnects to a surface that went away and came back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chathub-browser-sock-"))
    const socketPath = join(dir, "browser.sock")
    const first = await startFakeBrowser(ok({ text: "before" }), socketPath)
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: socketPath }))
    expect(firstText(await callTool(client, "browser_text"))).toBe("before")

    await first.stop()
    const whileClosed = await callTool(client, "browser_text")
    expect(whileClosed.isError).toBe(true)
    expect(firstText(whileClosed)).toBe(UNREACHABLE)

    const reopened = trackFake(await startFakeBrowser(ok({ text: "after" }), socketPath))
    expect(firstText(await callTool(client, "browser_text"))).toBe("after")
    expect(reopened.requests).toHaveLength(1)
    await rm(dir, { recursive: true, force: true })
  })
})

describe("browser MCP stdio framing", () => {
  it("handles two messages that arrive in one chunk", async () => {
    const client = track(startMcpServer())
    const both =
      `${JSON.stringify({ jsonrpc: "2.0", id: 101, method: "ping" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 102, method: "tools/list" })}\n`
    client.writeRaw(both)

    const first = await client.waitFor(101)
    const second = await client.waitFor(102)
    expect(first.result).toEqual({})
    expect((second.result?.tools as unknown[]).length).toBe(13)
  })

  it("buffers a half line until the rest arrives", async () => {
    const client = track(startMcpServer())
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: 201, method: "ping" })}\n`
    const cut = Math.floor(line.length / 2)
    client.writeRaw(line.slice(0, cut))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.received).toHaveLength(0)
    client.writeRaw(line.slice(cut))
    expect((await client.waitFor(201)).result).toEqual({})
  })

  it("answers unparsable input with a parse error and keeps going", async () => {
    const client = track(startMcpServer())
    client.writeRaw("{not json}\n")
    const parseError = await client.waitFor("null")
    expect(parseError.error?.code).toBe(-32700)
    expect((await client.request("ping")).result).toEqual({})
  })

  it("puts nothing but JSON-RPC on stdout, diagnostics included", async () => {
    const fake = trackFake(await startFakeBrowser(ok({ text: "hello" })))
    const client = track(startMcpServer({ [BROWSER_SOCKET_ENV]: fake.socketPath }))
    await client.request("initialize", { protocolVersion: "2024-11-05" })
    client.notify("notifications/initialized")
    await callTool(client, "browser_text")
    await callTool(client, "browser_click", {})
    client.writeRaw("garbage\n")
    await client.waitFor("null")

    const lines = client.stdout().split("\n").filter((l) => l.trim())
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const parsed = JSON.parse(line) as JsonRpcMessage
      expect(parsed.jsonrpc).toBe("2.0")
    }
  })
})

describe("browser MCP duplicated contract", () => {
  it("keeps the copied constants equal to src/shared/browser.ts", async () => {
    const mod = (await import("../resources/mcp/browser-mcp.mjs")) as unknown as Record<
      string,
      unknown
    >
    expect(mod.BROWSER_SOCKET_ENV).toBe(BROWSER_SOCKET_ENV)
    expect(mod.BROWSER_SESSION_ENV).toBe(BROWSER_SESSION_ENV)
    expect(mod.BROWSER_MCP_SERVER_NAME).toBe(BROWSER_MCP_SERVER_NAME)
    expect(mod.BROWSER_OP_TIMEOUT_MS).toBe(BROWSER_OP_TIMEOUT_MS)
    expect(mod.BROWSER_SNAPSHOT_CHAR_LIMIT).toBe(BROWSER_SNAPSHOT_CHAR_LIMIT)
    expect(mod.BROWSER_TEXT_CHAR_LIMIT).toBe(BROWSER_TEXT_CHAR_LIMIT)
    expect(mod.BROWSER_MODIFIERS).toEqual([...BROWSER_MODIFIERS])
  })

  it("renders snapshots byte-identically to the shared renderer", async () => {
    const mod = (await import("../resources/mcp/browser-mcp.mjs")) as unknown as {
      renderSnapshot: (s: BrowserSnapshot) => string
    }
    expect(mod.renderSnapshot(SAMPLE_SNAPSHOT)).toBe(renderSnapshot(SAMPLE_SNAPSHOT))

    const empty: BrowserSnapshot = {
      url: "about:blank",
      title: "",
      nodes: [],
      truncated: false,
    }
    expect(mod.renderSnapshot(empty)).toBe(renderSnapshot(empty))
  })
})
