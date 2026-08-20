import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { BrowserRequest, BrowserResponse } from "../src/shared/browser"
import { SURFACE_OPS, type SurfaceHandler } from "../src/shared/surface-control"
import { BrowserService, type BrowserExecutor } from "../src/main/browser-service"

class FakeExecutor implements BrowserExecutor {
  readonly guests = new Set<string>()
  readonly seen: BrowserRequest[] = []

  attach(sessionId: string): void {
    this.guests.add(sessionId)
  }

  detach(sessionId: string): void {
    this.guests.delete(sessionId)
  }

  hasGuest(sessionId: string): boolean {
    return this.guests.has(sessionId)
  }

  async handle(request: BrowserRequest): Promise<BrowserResponse> {
    this.seen.push(request)
    return { id: request.id, ok: true, result: { op: request.op } }
  }
}

const dirs: string[] = []
const services: BrowserService[] = []

async function makeService(
  requestOpen: (sessionId: string) => void,
  openWaitMs = 50,
  surfaces?: SurfaceHandler,
): Promise<{ service: BrowserService; executor: FakeExecutor }> {
  const dir = await mkdtemp(join(tmpdir(), "browser-service-"))
  dirs.push(dir)
  const executor = new FakeExecutor()
  const service = new BrowserService(join(dir, "browser.sock"), executor, {
    requestOpen,
    openWaitMs,
    surfaces,
  })
  services.push(service)
  return { service, executor }
}

function request(op: BrowserRequest["op"] = "snapshot"): BrowserRequest {
  return { id: "r1", sessionId: "s1", op, params: {} }
}

afterEach(async () => {
  for (const s of services.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe("BrowserService", () => {
  it("passes a request straight through when the surface is already attached", async () => {
    const open = vi.fn()
    const { service } = await makeService(open)
    service.attach("s1", 7)
    await expect(service.handle(request())).resolves.toEqual({
      id: "r1",
      ok: true,
      result: { op: "snapshot" },
    })
    expect(open).not.toHaveBeenCalled()
  })

  it("asks the renderer to open the surface when none is attached", async () => {
    const open = vi.fn()
    const { service } = await makeService(open)
    void service.handle(request())
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("s1"))
  })

  it("proceeds once the renderer attaches in response", async () => {
    const { service, executor } = await makeService((sessionId) => {
      setTimeout(() => service.attach(sessionId, 11), 5)
    })
    await expect(service.handle(request("navigate"))).resolves.toMatchObject({
      ok: true,
    })
    expect(executor.seen).toHaveLength(1)
  })

  it("gives an actionable error when the surface never appears", async () => {
    const { service, executor } = await makeService(() => {})
    const response = await service.handle(request())
    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error).toMatch(
      /Open the Browser surface/,
    )
    expect(executor.seen).toHaveLength(0)
  })

  it("only asks once per waiting request and serves both when the surface opens", async () => {
    const open = vi.fn()
    const { service, executor } = await makeService(open)
    const first = service.handle({ ...request(), id: "a" })
    const second = service.handle({ ...request(), id: "b" })
    await vi.waitFor(() => expect(open).toHaveBeenCalled())
    service.attach("s1", 3)
    await expect(first).resolves.toMatchObject({ id: "a", ok: true })
    await expect(second).resolves.toMatchObject({ id: "b", ok: true })
    expect(executor.seen.map((r) => r.id)).toEqual(["a", "b"])
  })

  it("a detached session asks for the surface again on the next request", async () => {
    const open = vi.fn()
    const { service } = await makeService(open)
    service.attach("s1", 4)
    await service.handle(request())
    service.detach("s1")
    void service.handle(request())
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
  })

  it("stopping releases everything waiting on a surface", async () => {
    const { service } = await makeService(() => {}, 60_000)
    const pending = service.handle(request())
    await service.stop()
    await expect(pending).resolves.toMatchObject({ ok: false })
  })

  it("routes a dock op away from the browser, without asking for a webview", async () => {
    const open = vi.fn()
    const surfaces: SurfaceHandler = async (req) => ({
      id: req.id,
      ok: true,
      result: { summary: `handled ${req.op}` },
    })
    const { service, executor } = await makeService(open, 50, surfaces)
    const response = await service.handle({
      id: "r1",
      sessionId: "s1",
      op: SURFACE_OPS.open as BrowserRequest["op"],
      params: { surface: "diff" },
    })
    expect(response).toMatchObject({
      ok: true,
      result: { summary: "handled surface.open" },
    })
    expect(open).not.toHaveBeenCalled()
    expect(executor.seen).toHaveLength(0)
  })

  it("refuses a dock op when nothing is wired to answer it", async () => {
    const { service } = await makeService(() => {})
    const response = await service.handle({
      id: "r1",
      sessionId: "s1",
      op: SURFACE_OPS.status as BrowserRequest["op"],
      params: {},
    })
    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error).toMatch(
      /not accepting panel commands/,
    )
  })

  it("listens on the socket it was given", async () => {
    const { service } = await makeService(() => {})
    await service.start()
    expect(service.listening).toBe(true)
    expect(service.socketPath).toMatch(/browser\.sock$/)
  })
})
