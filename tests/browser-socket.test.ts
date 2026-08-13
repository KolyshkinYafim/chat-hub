import { connect, type Socket } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import type { BrowserRequest, BrowserResponse } from "../src/shared/browser"
import { BrowserSocketServer } from "../src/main/browser-socket"

class Client {
  private socket: Socket | null = null
  private buffer = ""
  readonly lines: BrowserResponse[] = []
  private cursor = 0
  private waiters: ((line: BrowserResponse) => void)[] = []

  async connect(path: string): Promise<void> {
    const socket = connect(path)
    socket.setEncoding("utf8")
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    socket.on("data", (chunk: string) => {
      this.buffer += chunk
      let idx = this.buffer.indexOf("\n")
      while (idx !== -1) {
        const raw = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (raw) {
          const parsed = JSON.parse(raw) as BrowserResponse
          this.lines.push(parsed)
          const waiter = this.waiters.shift()
          if (waiter) waiter(parsed)
        }
        idx = this.buffer.indexOf("\n")
      }
    })
    this.socket = socket
  }

  writeRaw(text: string): void {
    this.socket?.write(text)
  }

  next(): Promise<BrowserResponse> {
    const ready = this.lines[this.cursor]
    if (ready) {
      this.cursor += 1
      return Promise.resolve(ready)
    }
    return new Promise((resolve) =>
      this.waiters.push((line) => {
        this.cursor += 1
        resolve(line)
      }),
    )
  }

  close(): void {
    this.socket?.destroy()
  }
}

const started: BrowserSocketServer[] = []
const clients: Client[] = []
const dirs: string[] = []

async function startServer(
  handle: (r: BrowserRequest) => Promise<BrowserResponse>,
): Promise<{ server: BrowserSocketServer; client: Client }> {
  const dir = await mkdtemp(join(tmpdir(), "browser-socket-"))
  dirs.push(dir)
  const server = new BrowserSocketServer(join(dir, "browser.sock"), handle)
  await server.start()
  started.push(server)
  const client = new Client()
  await client.connect(server.path)
  clients.push(client)
  return { server, client }
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of started.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe("BrowserSocketServer", () => {
  it("answers a request with the handler's response, keyed by id", async () => {
    const { client } = await startServer(async (r) => ({
      id: r.id,
      ok: true,
      result: { echo: r.op },
    }))
    client.writeRaw(
      JSON.stringify({ id: "a1", sessionId: "s", op: "snapshot", params: {} }) +
        "\n",
    )
    await expect(client.next()).resolves.toEqual({
      id: "a1",
      ok: true,
      result: { echo: "snapshot" },
    })
  })

  it("keeps one connection open across many requests", async () => {
    const { client } = await startServer(async (r) => ({
      id: r.id,
      ok: true,
      result: {},
    }))
    for (const id of ["1", "2", "3"]) {
      client.writeRaw(
        JSON.stringify({ id, sessionId: "s", op: "text", params: {} }) + "\n",
      )
    }
    await client.next()
    await client.next()
    await client.next()
    expect(client.lines.map((l) => l.id)).toEqual(["1", "2", "3"])
  })

  it("handles two requests arriving in a single chunk", async () => {
    const { client } = await startServer(async (r) => ({
      id: r.id,
      ok: true,
      result: {},
    }))
    client.writeRaw(
      JSON.stringify({ id: "x", sessionId: "s", op: "text", params: {} }) +
        "\n" +
        JSON.stringify({ id: "y", sessionId: "s", op: "text", params: {} }) +
        "\n",
    )
    await client.next()
    await client.next()
    expect(client.lines.map((l) => l.id)).toEqual(["x", "y"])
  })

  it("buffers a request split across chunks", async () => {
    const { client } = await startServer(async (r) => ({
      id: r.id,
      ok: true,
      result: {},
    }))
    const line = JSON.stringify({
      id: "split",
      sessionId: "s",
      op: "text",
      params: {},
    })
    client.writeRaw(line.slice(0, 10))
    client.writeRaw(line.slice(10) + "\n")
    await expect(client.next()).resolves.toMatchObject({ id: "split" })
  })

  it("rejects a malformed line instead of dropping the connection", async () => {
    const { client } = await startServer(async (r) => ({
      id: r.id,
      ok: true,
      result: {},
    }))
    client.writeRaw("not json\n")
    await expect(client.next()).resolves.toMatchObject({ ok: false })
    client.writeRaw(
      JSON.stringify({ id: "after", sessionId: "s", op: "text", params: {} }) +
        "\n",
    )
    await expect(client.next()).resolves.toMatchObject({ id: "after", ok: true })
  })

  it("rejects a request missing a session id", async () => {
    const { client } = await startServer(async (r) => ({
      id: r.id,
      ok: true,
      result: {},
    }))
    client.writeRaw(JSON.stringify({ id: "n", op: "text", params: {} }) + "\n")
    await expect(client.next()).resolves.toMatchObject({ ok: false })
  })

  it("turns a handler rejection into an error response, not a crash", async () => {
    const { client } = await startServer(async () => {
      throw new Error("guest exploded")
    })
    client.writeRaw(
      JSON.stringify({ id: "boom", sessionId: "s", op: "click", params: {} }) +
        "\n",
    )
    await expect(client.next()).resolves.toEqual({
      id: "boom",
      ok: false,
      error: "guest exploded",
    })
  })

  it("defaults missing params to an empty object", async () => {
    let seen: BrowserRequest | null = null
    const { client } = await startServer(async (r) => {
      seen = r
      return { id: r.id, ok: true, result: {} }
    })
    client.writeRaw(
      JSON.stringify({ id: "p", sessionId: "s", op: "screenshot" }) + "\n",
    )
    await client.next()
    expect(seen).toMatchObject({ params: {} })
  })

  it("stops listening and removes the socket file", async () => {
    const { server } = await startServer(async (r) => ({
      id: r.id,
      ok: true,
      result: {},
    }))
    expect(server.listening).toBe(true)
    await server.stop()
    expect(server.listening).toBe(false)
    await expect(new Client().connect(server.path)).rejects.toThrow()
  })

  it("starting twice is a no-op rather than a bind failure", async () => {
    const { server } = await startServer(async (r) => ({
      id: r.id,
      ok: true,
      result: {},
    }))
    await expect(server.start()).resolves.toBeUndefined()
    expect(server.listening).toBe(true)
  })
})
