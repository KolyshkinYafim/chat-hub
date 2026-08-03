import { once } from "node:events"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface, type Interface as ReadlineInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

import type { ClientNotification } from "./generated/ClientNotification"
import type { RequestId } from "./generated/RequestId"
import type { ServerNotification } from "./generated/ServerNotification"
import type { ServerRequest } from "./generated/ServerRequest"
import type { InitializeResponse } from "./generated/InitializeResponse"

type RpcError = {
  code: number
  message: string
  data?: unknown
}

type RpcResponse = {
  id: RequestId
  result?: unknown
  error?: RpcError
}

type RpcRequest = {
  id: RequestId
  method: string
  params?: unknown
}

type RpcNotification = {
  method: string
  params?: unknown
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type CodexNotificationHandler = (notification: ServerNotification) => void
export type CodexServerRequestHandler = (request: ServerRequest) => void
export type CodexCloseHandler = (error: Error) => void

export type CodexRpcTransport = {
  input: Readable
  output: Writable
  stderr?: Readable
  close: () => Promise<void>
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export type CodexAppServerOptions = {
  binary: string
  cwd?: string
  env?: Record<string, string>
  requestTimeoutMs?: number
  clientVersion?: string
  transportFactory?: () => CodexRpcTransport
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_STDERR_LINES = 80

/** Error returned by a JSON-RPC response from codex app-server. */
export class CodexRpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(method: string, error: RpcError) {
    super(`Codex ${method} failed (${error.code}): ${error.message}`)
    this.name = "CodexRpcError"
    this.code = error.code
    this.data = error.data
  }
}

/**
 * One initialized, long-lived JSONL connection to `codex app-server`.
 *
 * It owns framing, request correlation, timeouts, server requests and clean
 * shutdown. Provider-specific thread/turn logic belongs in the adapter.
 */
export class CodexAppServerClient {
  private readonly transport: CodexRpcTransport
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<RequestId, PendingRequest>()
  private readonly notificationHandlers = new Set<CodexNotificationHandler>()
  private readonly serverRequestHandlers = new Set<CodexServerRequestHandler>()
  private readonly closeHandlers = new Set<CodexCloseHandler>()
  private readonly stderrLines: string[] = []
  private readonly inputLines: ReadlineInterface
  private readonly stderrReader: ReadlineInterface | null
  private nextRequestId = 1
  private closing = false
  private exited = false

  private constructor(transport: CodexRpcTransport, requestTimeoutMs: number) {
    this.transport = transport
    this.requestTimeoutMs = requestTimeoutMs
    this.inputLines = createInterface({ input: transport.input, crlfDelay: Infinity })
    this.stderrReader = transport.stderr
      ? createInterface({ input: transport.stderr, crlfDelay: Infinity })
      : null

    this.inputLines.on("line", (line) => this.handleLine(line))
    this.inputLines.on("error", (error) => this.failConnection(error))
    this.stderrReader?.on("line", (line) => {
      this.stderrLines.push(line)
      if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.shift()
    })
    void transport.exited.then(({ code, signal }) => {
      this.exited = true
      if (this.closing) return
      const tail = this.stderrLines.slice(-12).join("\n")
      const detail = tail ? `\n${tail}` : ""
      this.failConnection(
        new Error(
          `Codex app-server exited unexpectedly (code ${String(code)}, signal ${String(signal)}).${detail}`,
        ),
      )
    })
  }

  static async connect(options: CodexAppServerOptions): Promise<CodexAppServerClient> {
    const transport = options.transportFactory
      ? options.transportFactory()
      : spawnTransport(options.binary, options.cwd, options.env)
    const client = new CodexAppServerClient(
      transport,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    )

    try {
      await client.request<InitializeResponse>("initialize", {
        clientInfo: {
          name: "chat_hub",
          title: "Chat Hub",
          version: options.clientVersion ?? "0.1.0",
        },
        capabilities: null,
      })
      await client.notify({ method: "initialized" })
      return client
    } catch (error) {
      await client.close()
      throw new Error("Failed to initialize Codex app-server", { cause: error })
    }
  }

  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onServerRequest(handler: CodexServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler)
    return () => this.serverRequestHandlers.delete(handler)
  }

  onClose(handler: CodexCloseHandler): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  async request<Result>(method: string, params?: unknown): Promise<Result> {
    this.assertOpen()
    const id = this.nextRequestId++
    const result = new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out after ${this.requestTimeoutMs} ms`))
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as Result),
        reject,
        timer,
      })
    })

    try {
      await this.write({ id, method, params })
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return result
  }

  async notify(notification: ClientNotification | RpcNotification): Promise<void> {
    this.assertOpen()
    await this.write(notification)
  }

  /** Reply to a request initiated by app-server (approval, question, elicitation). */
  async respond(id: RequestId, result: unknown): Promise<void> {
    this.assertOpen()
    await this.write({ id, result })
  }

  async respondError(id: RequestId, error: RpcError): Promise<void> {
    this.assertOpen()
    await this.write({ id, error })
  }

  recentStderr(): string[] {
    return [...this.stderrLines]
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const error = new Error("Codex app-server connection closed")
    this.rejectPending(error)
    this.inputLines.close()
    this.stderrReader?.close()
    if (!this.exited) await this.transport.close()
  }

  private assertOpen(): void {
    if (this.closing || this.exited) {
      throw new Error("Codex app-server connection is not open")
    }
  }

  private async write(message: unknown): Promise<void> {
    const line = `${JSON.stringify(message)}\n`
    if (this.transport.output.write(line)) return
    await once(this.transport.output, "drain")
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch (error) {
      this.failConnection(new Error(`Invalid JSON from Codex app-server: ${line}`, { cause: error }))
      return
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return
    const record = message as Record<string, unknown>

    if ((typeof record.id === "string" || typeof record.id === "number") &&
        ("result" in record || "error" in record) && !("method" in record)) {
      this.handleResponse(record as RpcResponse)
      return
    }

    if (typeof record.method !== "string") return
    if (typeof record.id === "string" || typeof record.id === "number") {
      for (const handler of this.serverRequestHandlers) {
        handler(record as RpcRequest as ServerRequest)
      }
      return
    }
    for (const handler of this.notificationHandlers) {
      handler(record as RpcNotification as ServerNotification)
    }
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.id)
    if (response.error) {
      pending.reject(new CodexRpcError(pending.method, response.error))
      return
    }
    pending.resolve(response.result)
  }

  private failConnection(error: Error): void {
    if (this.closing) return
    this.closing = true
    this.rejectPending(error)
    for (const handler of this.closeHandlers) handler(error)
    this.closeHandlers.clear()
    this.inputLines.close()
    this.stderrReader?.close()
    if (!this.exited) void this.transport.close()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function spawnTransport(
  binary: string,
  cwd: string | undefined,
  extraEnv: Record<string, string> | undefined,
): CodexRpcTransport {
  const child = spawn(binary, ["app-server"], {
    cwd,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const exited = processExit(child)
  return {
    input: child.stdout,
    output: child.stdin,
    stderr: child.stderr,
    exited,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.stdin.end()
      child.kill("SIGTERM")
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000)
      timer.unref?.()
      await exited
      clearTimeout(timer)
    },
  }
}

function processExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
    child.once("error", () => resolve({ code: child.exitCode, signal: child.signalCode }))
  })
}
