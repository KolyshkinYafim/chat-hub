import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { McpServerDef } from "@shared/mcp"

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`kc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^kc:/, ""),
  },
}))

const { probeHttp, probeMcpStatuses } = await import("../src/main/mcp")

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  )
})

async function fakeMcp(
  statusCode: number,
  onRequest?: (method: string | undefined, body: string) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    let body = ""
    req.setEncoding("utf8")
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", () => {
      onRequest?.(req.method, body)
      res.writeHead(statusCode, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/mcp`
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function httpDef(id: string, url: string, enabled = true): McpServerDef {
  return { id, name: id, enabled, transport: "http", args: [], envKeys: [], url }
}

describe("probeHttp", () => {
  it("posts a JSON-RPC initialize and reports ok on 200", async () => {
    let seenMethod: string | undefined
    let seenBody = ""
    const url = await fakeMcp(200, (method, body) => {
      seenMethod = method
      seenBody = body
    })
    const outcome = await probeHttp(url)
    expect(outcome).toEqual({ state: "ok", detail: url })
    expect(seenMethod).toBe("POST")
    const rpc = JSON.parse(seenBody) as { jsonrpc: string; method: string }
    expect(rpc.jsonrpc).toBe("2.0")
    expect(rpc.method).toBe("initialize")
  })

  it("maps 401 and 403 to Needs sign-in", async () => {
    expect(await probeHttp(await fakeMcp(401))).toEqual({
      state: "unknown",
      detail: "Needs sign-in",
    })
    expect(await probeHttp(await fakeMcp(403))).toEqual({
      state: "unknown",
      detail: "Needs sign-in",
    })
  })

  it("reports other failures with their status code", async () => {
    expect(await probeHttp(await fakeMcp(500))).toEqual({
      state: "error",
      detail: "HTTP 500",
    })
  })

  it("maps a refused connection to Unreachable", async () => {
    const port = await freePort()
    expect(await probeHttp(`http://127.0.0.1:${port}/mcp`)).toEqual({
      state: "error",
      detail: "Unreachable",
    })
  })

  it("rejects an unparsable url as Unreachable", async () => {
    expect(await probeHttp("not a url")).toEqual({
      state: "error",
      detail: "Unreachable",
    })
  })
})

describe("probeMcpStatuses", () => {
  it("probes enabled http servers and leaves disabled ones alone", async () => {
    const url = await fakeMcp(200)
    const statuses = await probeMcpStatuses([
      httpDef("live", url),
      httpDef("off", url, false),
    ])
    expect(statuses.map((s) => [s.id, s.state])).toEqual([
      ["live", "ok"],
      ["off", "disabled"],
    ])
  })
})
