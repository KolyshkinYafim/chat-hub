import { createServer, connect, type Server, type Socket } from "node:net"
import { chmodSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import type { PermissionDecision } from "@shared/types"

/**
 * Both halves of the island's permission protocol, spoken verbatim
 * (session-monitor/docs/bridge.md + Services/MonitorSocketServer.swift):
 *
 *   hook → server  {"v":1,"source":"claude","event":"PermissionRequest",
 *                   "sessionId":"…","requestId":"…","summary":"…","payload":{…}}
 *   server → hook  {"decision":{"behavior":"allow"|"deny"}}
 *
 * The Hub runs a server (its own CLIs ask it) and a client (it mirrors every
 * request onto the island). Fail-open everywhere: a hook that gets no answer
 * exits 0 and Claude falls back to its own prompt, so a Hub bug can never
 * silently approve or block a tool call.
 */

export type RawPermissionRequest = {
  v?: number
  source?: string
  sessionId?: string
  requestId?: string
  summary?: string
  payload?: Record<string, unknown>
}

export type IncomingRequest = {
  raw: RawPermissionRequest
  /** Answer the waiting hook. Second call is a no-op. */
  answer: (behavior: PermissionDecision) => void
  /**
   * Hang up without deciding. The hook reads EOF and falls open, which is the
   * only honest outcome when the Hub can no longer show anyone the request.
   */
  dismiss: () => void
  /** The hook went away — nothing left to answer. */
  onGone: (cb: () => void) => void
}

export class HubPermissionServer {
  private server: Server | null = null
  private sockets = new Set<Socket>()

  constructor(
    private readonly socketPath: string,
    private readonly onRequest: (request: IncomingRequest) => void,
  ) {}

  get path(): string {
    return this.socketPath
  }

  get listening(): boolean {
    return this.server !== null
  }

  async start(): Promise<void> {
    if (this.server) return
    mkdirSync(dirname(this.socketPath), { recursive: true })
    // A socket file left by a crash refuses bind; nobody can be listening on it
    // because a second Hub instance is already prevented by Electron's lock.
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
    // Same as the island: owner-only, hooks run as the same user.
    try {
      chmodSync(this.socketPath, 0o600)
    } catch {
      /* best effort — a working socket beats a failed start */
    }
    server.on("error", (err) => {
      console.error("[permission-socket] server error", err)
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
    let answered = false
    const goneHandlers: (() => void)[] = []

    const close = (): void => {
      this.sockets.delete(socket)
      socket.end()
    }

    const handleLine = (line: string): void => {
      let obj: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(line)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          obj = parsed as Record<string, unknown>
        }
      } catch {
        /* unparseable noise — handled below */
      }
      if (!obj) {
        close()
        return
      }
      if (obj.event !== "PermissionRequest") {
        // Anything else on this socket is a SessionEvent the island also takes.
        // The Hub is not a consumer of those, but the sender waits for an ack,
        // so acknowledging and closing is what keeps it from blocking on us.
        socket.write('{"ok":true}\n')
        close()
        return
      }
      this.onRequest({
        raw: obj as RawPermissionRequest,
        answer: (behavior) => {
          if (answered) return
          answered = true
          socket.write(`${JSON.stringify({ decision: { behavior } })}\n`)
          close()
        },
        dismiss: () => {
          // Marked answered so our own hang-up does not come back as "the hook
          // went away" and cancel a request we are already cancelling.
          if (answered) return
          answered = true
          close()
        },
        onGone: (cb) => goneHandlers.push(cb),
      })
    }

    socket.on("data", (chunk: string) => {
      buffer += chunk
      let idx = buffer.indexOf("\n")
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) handleLine(line)
        idx = buffer.indexOf("\n")
      }
    })
    socket.on("error", () => close())
    socket.on("close", () => {
      this.sockets.delete(socket)
      if (answered) return
      for (const fn of goneHandlers) fn()
    })
  }
}

export type IslandMirror = {
  /** Resolves with the island's decision, or null if it never gave one. */
  decision: Promise<PermissionDecision | null>
  /** Hang up so the island drops its own card (its EOF path clears it). */
  cancel: () => void
}

/**
 * Mirror one request onto the island and wait for its answer. Returns null
 * immediately when the island is not running — the Hub then owns the decision
 * alone, which is exactly the pre-island behaviour.
 */
export function mirrorToIsland(
  socketPath: string,
  raw: RawPermissionRequest,
): IslandMirror {
  let settle: (value: PermissionDecision | null) => void = () => {}
  const decision = new Promise<PermissionDecision | null>((resolve) => {
    settle = resolve
  })

  let socket: Socket | null = null
  try {
    socket = connect(socketPath)
  } catch {
    settle(null)
    return { decision, cancel: () => {} }
  }

  const client = socket
  let buffer = ""
  client.setEncoding("utf8")
  client.on("connect", () => {
    client.write(`${JSON.stringify(raw)}\n`)
  })
  client.on("data", (chunk: string) => {
    buffer += chunk
    const idx = buffer.indexOf("\n")
    if (idx === -1) return
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    let behavior: unknown
    try {
      behavior = (
        JSON.parse(line) as { decision?: { behavior?: unknown } }
      ).decision?.behavior
    } catch {
      behavior = undefined
    }
    settle(behavior === "allow" || behavior === "deny" ? behavior : null)
    client.destroy()
  })
  // Island down, socket file stale, app quit mid-wait — all mean "no answer
  // from that surface", never "deny".
  client.on("error", () => settle(null))
  client.on("close", () => settle(null))

  return {
    decision,
    cancel: () => client.destroy(),
  }
}
