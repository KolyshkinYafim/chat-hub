import { createServer, type Server, type Socket } from "node:net"
import { chmodSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import type { BrowserRequest, BrowserResponse } from "@shared/browser"

export type BrowserRequestHandler = (
  request: BrowserRequest,
) => Promise<BrowserResponse>

function parseRequest(line: string): BrowserRequest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.id !== "string" || obj.id === "") return null
  if (typeof obj.sessionId !== "string" || obj.sessionId === "") return null
  if (typeof obj.op !== "string" || obj.op === "") return null
  const params =
    obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : {}
  return {
    id: obj.id,
    sessionId: obj.sessionId,
    op: obj.op as BrowserRequest["op"],
    params,
  }
}

/**
 * Long-lived counterpart to the permission socket: one connection carries many
 * requests, correlated by id, because an agent's browser turn is a burst of
 * snapshot/click/snapshot rather than a single blocking question.
 */
export class BrowserSocketServer {
  private server: Server | null = null
  private sockets = new Set<Socket>()

  constructor(
    private readonly socketPath: string,
    private readonly handle: BrowserRequestHandler,
  ) {}

  get path(): string {
    return this.socketPath
  }

  get listening(): boolean {
    return this.server !== null
  }

  get connectionCount(): number {
    return this.sockets.size
  }

  async start(): Promise<void> {
    if (this.server) return
    mkdirSync(dirname(this.socketPath), { recursive: true })
    try {
      unlinkSync(this.socketPath)
    } catch {
      /* nothing to clear */
    }

    const server = createServer((socket) => this.adopt(socket))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
    try {
      chmodSync(this.socketPath, 0o600)
    } catch {
      /* best effort — a working socket beats a failed start */
    }
    server.on("error", (err) => {
      console.error("[browser-socket] server error", err)
    })
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      unlinkSync(this.socketPath)
    } catch {
      /* already gone */
    }
  }

  private adopt(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding("utf8")
    let buffer = ""

    const send = (response: BrowserResponse): void => {
      if (socket.destroyed) return
      socket.write(`${JSON.stringify(response)}\n`)
    }

    const dispatch = (line: string): void => {
      const request = parseRequest(line)
      if (!request) {
        send({ id: "", ok: false, error: "Malformed browser request" })
        return
      }
      this.handle(request)
        .then(send)
        .catch((e: unknown) => {
          send({
            id: request.id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          })
        })
    }

    socket.on("data", (chunk: string) => {
      buffer += chunk
      let idx = buffer.indexOf("\n")
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) dispatch(line)
        idx = buffer.indexOf("\n")
      }
    })
    socket.on("error", () => {
      this.sockets.delete(socket)
      socket.destroy()
    })
    socket.on("close", () => {
      this.sockets.delete(socket)
    })
  }
}
