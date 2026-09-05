import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import {
  HUB_OP_PREFIX,
  HUB_OPS,
  type HubRequest,
  type HubResponse,
} from "@shared/hub-control"
import { automationRequest } from "./deep-links"

export const AUTOMATION_HOST = "127.0.0.1"
export const AUTOMATION_PATH_PREFIX = "/hub/"
export const AUTOMATION_MAX_BODY_BYTES = 64 * 1024

const KNOWN_OPS = new Set<string>(Object.values(HUB_OPS))

export type AutomationServerDeps = {
  token: () => string
  hub: (request: HubRequest) => Promise<HubResponse>
}

export function generateAutomationToken(): string {
  return randomBytes(24).toString("base64url")
}

export function automationOpForPath(path: string): string | null {
  if (!path.startsWith(AUTOMATION_PATH_PREFIX)) return null
  const command = path.slice(AUTOMATION_PATH_PREFIX.length)
  if (command === "" || command.includes("/")) return null
  const op = `${HUB_OP_PREFIX}${command}`
  return KNOWN_OPS.has(op) ? op : null
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header || token === "") return false
  const [scheme, presented, ...rest] = header.trim().split(/\s+/)
  if (rest.length > 0 || scheme?.toLowerCase() !== "bearer" || !presented) {
    return false
  }
  const a = Buffer.from(presented, "utf8")
  const b = Buffer.from(token, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > AUTOMATION_MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", () => resolve(null))
  })
}

function parseParams(body: string): Record<string, unknown> | null {
  if (body.trim() === "") return {}
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

export class AutomationServer {
  private server: Server | null = null
  private listeningPort: number | null = null

  constructor(private readonly deps: AutomationServerDeps) {}

  get port(): number | null {
    return this.listeningPort
  }

  get running(): boolean {
    return this.server !== null
  }

  start(): Promise<number> {
    if (this.server && this.listeningPort !== null) {
      return Promise.resolve(this.listeningPort)
    }
    const server = createServer((req, res) => void this.handle(req, res))
    this.server = server
    return new Promise((resolve, reject) => {
      server.once("error", (err) => {
        this.server = null
        reject(err)
      })
      server.listen(0, AUTOMATION_HOST, () => {
        const port = (server.address() as AddressInfo).port
        this.listeningPort = port
        resolve(port)
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.listeningPort = null
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!bearerMatches(req.headers.authorization, this.deps.token())) {
      send(res, 401, { ok: false, error: "A valid bearer token is required." })
      return
    }
    const path = new URL(req.url ?? "/", `http://${AUTOMATION_HOST}`).pathname
    const op = automationOpForPath(path)
    if (!op) {
      send(res, 404, { ok: false, error: `No hub command at ${path}.` })
      return
    }
    if (req.method !== "POST") {
      send(res, 405, { ok: false, error: "Hub commands are POST only." })
      return
    }
    const body = await readBody(req)
    const params = body === null ? null : parseParams(body)
    if (params === null) {
      send(res, 400, {
        ok: false,
        error: `The body must be a JSON object under ${AUTOMATION_MAX_BODY_BYTES} bytes.`,
      })
      return
    }
    const response = await this.deps.hub(automationRequest(op, params))
    send(res, response.ok ? 200 : 400, response)
  }
}
