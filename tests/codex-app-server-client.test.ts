import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"

import {
  CodexAppServerClient,
  CodexRpcError,
  type CodexRpcTransport,
} from "../src/main/codex-protocol/client"

function harness() {
  const serverToClient = new PassThrough()
  const clientToServer = new PassThrough()
  const stderr = new PassThrough()
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      resolveExit = resolve
    },
  )
  const lines: Record<string, unknown>[] = []
  let pending = ""
  clientToServer.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8")
    const split = pending.split("\n")
    pending = split.pop() ?? ""
    for (const line of split.filter(Boolean)) lines.push(JSON.parse(line))
  })
  const close = vi.fn(async () => {
    resolveExit({ code: 0, signal: null })
  })
  const transport: CodexRpcTransport = {
    input: serverToClient,
    output: clientToServer,
    stderr,
    close,
    exited,
  }
  return { serverToClient, stderr, lines, transport, close, resolveExit }
}

async function connect(h = harness(), requestTimeoutMs = 500) {
  const connecting = CodexAppServerClient.connect({
    binary: "fake-codex",
    requestTimeoutMs,
    transportFactory: () => h.transport,
  })
  await vi.waitFor(() => expect(h.lines).toHaveLength(1))
  expect(h.lines[0]).toMatchObject({
    method: "initialize",
    params: { clientInfo: { name: "chat_hub", title: "Chat Hub" } },
  })
  h.serverToClient.write(`${JSON.stringify({ id: h.lines[0]!.id, result: { userAgent: "fake/1" } })}\n`)
  const client = await connecting
  expect(h.lines[1]).toEqual({ method: "initialized" })
  return { client, ...h }
}

describe("CodexAppServerClient", () => {
  it("initializes once, correlates requests and delivers notifications", async () => {
    const h = await connect()
    const notifications: unknown[] = []
    h.client.onNotification((notification) => notifications.push(notification))

    const models = h.client.request<{ data: { id: string }[] }>("model/list", {
      limit: 20,
    })
    await vi.waitFor(() => expect(h.lines).toHaveLength(3))
    h.serverToClient.write(
      `${JSON.stringify({ id: h.lines[2]!.id, result: { data: [{ id: "gpt-test" }] } })}\n`,
    )
    await expect(models).resolves.toEqual({ data: [{ id: "gpt-test" }] })

    h.serverToClient.write(
      `${JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } })}\n`,
    )
    await vi.waitFor(() => expect(notifications).toHaveLength(1))
    expect(notifications[0]).toMatchObject({ method: "turn/started" })
    await h.client.close()
  })

  it("surfaces typed RPC errors with the method and code", async () => {
    const h = await connect()
    const request = h.client.request("thread/read", { threadId: "missing" })
    await vi.waitFor(() => expect(h.lines).toHaveLength(3))
    h.serverToClient.write(
      `${JSON.stringify({
        id: h.lines[2]!.id,
        error: { code: -32004, message: "thread not found", data: { threadId: "missing" } },
      })}\n`,
    )
    await expect(request).rejects.toMatchObject({
      name: "CodexRpcError",
      code: -32004,
      data: { threadId: "missing" },
    } satisfies Partial<CodexRpcError>)
    await h.client.close()
  })

  it("routes server requests and can answer them", async () => {
    const h = await connect()
    const requests: unknown[] = []
    h.client.onServerRequest((request) => requests.push(request))
    h.serverToClient.write(
      `${JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thr", turnId: "turn", itemId: "item" },
      })}\n`,
    )
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await h.client.respond("approval-1", { decision: "accept" })
    expect(h.lines.at(-1)).toEqual({ id: "approval-1", result: { decision: "accept" } })
    await h.client.close()
  })

  it("rejects pending work when the process exits and includes stderr", async () => {
    const h = await connect()
    const request = h.client.request("model/list", {})
    h.stderr.write("fatal: auth store unreadable\n")
    h.resolveExit({ code: 2, signal: null })
    await expect(request).rejects.toThrow(/auth store unreadable/)
  })

  it("times out a request instead of leaking it forever", async () => {
    const h = await connect(harness(), 20)
    await expect(h.client.request("model/list", {})).rejects.toThrow(/timed out/)
    await h.client.close()
  })
})
