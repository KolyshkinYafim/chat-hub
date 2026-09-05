import { afterEach, describe, expect, it } from "vitest"
import { HUB_OPS, type HubRequest, type HubResponse } from "@shared/hub-control"
import {
  AUTOMATION_HOST,
  AUTOMATION_MAX_BODY_BYTES,
  AutomationServer,
  automationOpForPath,
  bearerMatches,
  generateAutomationToken,
} from "../src/main/automation-server"

const TOKEN = "test-token-123"

type Harness = {
  server: AutomationServer
  requests: HubRequest[]
  port: number
}

const running: AutomationServer[] = []

async function start(
  hub?: (request: HubRequest) => Promise<HubResponse>,
): Promise<Harness> {
  const requests: HubRequest[] = []
  const server = new AutomationServer({
    token: () => TOKEN,
    hub:
      hub ??
      ((request) => {
        requests.push(request)
        return Promise.resolve({
          id: request.id,
          ok: true,
          result: { summary: `ran ${request.op}`, windowId: 1 },
        })
      }),
  })
  const port = await server.start()
  running.push(server)
  return { server, requests, port }
}

function call(
  port: number,
  path: string,
  init: { method?: string; token?: string | null; body?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (init.token !== null) {
    headers.authorization = `Bearer ${init.token ?? TOKEN}`
  }
  return fetch(`http://${AUTOMATION_HOST}:${port}${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" ? undefined : (init.body ?? "{}"),
  })
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()))
})

describe("automationOpForPath", () => {
  it("maps /hub/<command> onto the hub op of the same name", () => {
    expect(automationOpForPath("/hub/arrange")).toBe(HUB_OPS.arrange)
    expect(automationOpForPath("/hub/list-windows")).toBe(HUB_OPS.listWindows)
    expect(automationOpForPath("/hub/open-surface")).toBe(HUB_OPS.openSurface)
  })

  it.each(["/hub/", "/hub", "/hub/nope", "/hub/arrange/extra", "/arrange", "/"])(
    "rejects %s",
    (path) => {
      expect(automationOpForPath(path)).toBeNull()
    },
  )
})

describe("bearerMatches", () => {
  it("accepts the exact token in any header case", () => {
    expect(bearerMatches("Bearer abc", "abc")).toBe(true)
    expect(bearerMatches("bearer abc", "abc")).toBe(true)
  })

  it.each([
    undefined,
    "",
    "abc",
    "Basic abc",
    "Bearer",
    "Bearer abd",
    "Bearer ab",
    "Bearer abc extra",
  ])("rejects %j", (header) => {
    expect(bearerMatches(header, "abc")).toBe(false)
  })

  it("never matches an empty stored token", () => {
    expect(bearerMatches("Bearer ", "")).toBe(false)
  })
})

describe("generateAutomationToken", () => {
  it("makes long, url-safe, distinct tokens", () => {
    const a = generateAutomationToken()
    const b = generateAutomationToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(a).not.toBe(b)
  })
})

describe("AutomationServer", () => {
  it("binds loopback on an ephemeral port and reports it", async () => {
    const h = await start()
    expect(h.port).toBeGreaterThan(0)
    expect(h.server.port).toBe(h.port)
    expect(h.server.running).toBe(true)
  })

  it("runs a hub command with the token and returns the hub's response", async () => {
    const h = await start()
    const res = await call(h.port, "/hub/arrange", {
      body: JSON.stringify({ preset: "review" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as HubResponse
    expect(body.ok).toBe(true)
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({
      op: HUB_OPS.arrange,
      params: { preset: "review" },
    })
  })

  it("treats an empty body as no params", async () => {
    const h = await start()
    const res = await call(h.port, "/hub/list-windows", { body: "" })
    expect(res.status).toBe(200)
    expect(h.requests[0]?.params).toEqual({})
  })

  it("answers 401 without a token, with a wrong token, and before any command check", async () => {
    const h = await start()
    expect((await call(h.port, "/hub/arrange", { token: null })).status).toBe(401)
    expect((await call(h.port, "/hub/arrange", { token: "nope" })).status).toBe(401)
    expect((await call(h.port, "/hub/unknown", { token: null })).status).toBe(401)
    expect(h.requests).toEqual([])
  })

  it("answers 404 for an unknown command and 405 for a non-POST", async () => {
    const h = await start()
    expect((await call(h.port, "/hub/unknown")).status).toBe(404)
    expect((await call(h.port, "/other")).status).toBe(404)
    expect((await call(h.port, "/hub/arrange", { method: "GET" })).status).toBe(405)
    expect(h.requests).toEqual([])
  })

  it("answers 400 for a body that is not a JSON object", async () => {
    const h = await start()
    expect((await call(h.port, "/hub/arrange", { body: "not json" })).status).toBe(400)
    expect((await call(h.port, "/hub/arrange", { body: "[1]" })).status).toBe(400)
    const huge = JSON.stringify({ preset: "x".repeat(AUTOMATION_MAX_BODY_BYTES) })
    const res = await call(h.port, "/hub/arrange", { body: huge }).catch(() => null)
    expect(res?.status ?? 400).toBe(400)
    expect(h.requests).toEqual([])
  })

  it("passes a hub refusal through as 400 with the hub's shape", async () => {
    const h = await start((request) =>
      Promise.resolve({ id: request.id, ok: false, error: "No session s-9." }),
    )
    const res = await call(h.port, "/hub/focus-session", {
      body: JSON.stringify({ sessionId: "s-9" }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: "No session s-9." })
  })

  it("stops and refuses connections afterwards", async () => {
    const h = await start()
    await h.server.stop()
    expect(h.server.running).toBe(false)
    expect(h.server.port).toBeNull()
    await expect(call(h.port, "/hub/arrange")).rejects.toThrow()
  })

  it("restarts on a fresh port after a stop", async () => {
    const h = await start()
    await h.server.stop()
    const port = await h.server.start()
    expect(port).toBeGreaterThan(0)
    expect((await call(port, "/hub/list-windows")).status).toBe(200)
  })
})
