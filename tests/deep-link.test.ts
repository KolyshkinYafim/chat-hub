import { describe, expect, it } from "vitest"
import {
  DEEP_LINK_ROUTES,
  deepLinkFromArgv,
  isDeepLink,
  parseDeepLink,
  sessionDeepLink,
} from "@shared/deep-link"
import { HUB_OPS, type HubRequest, type HubResponse } from "@shared/hub-control"
import {
  DEEP_LINK_PROMPT_PREVIEW_CHARS,
  DeepLinkDispatcher,
  deepLinkPromptPreview,
  hubRequestFor,
  type DeepLinkDeps,
  type DeepLinkNewSession,
} from "../src/main/deep-links"

function command(raw: string) {
  const parsed = parseDeepLink(raw)
  expect(parsed.ok).toBe(true)
  return parsed.ok ? parsed.command : null
}

function error(raw: string): string {
  const parsed = parseDeepLink(raw)
  expect(parsed.ok).toBe(false)
  return parsed.ok ? "" : parsed.error
}

describe("parseDeepLink", () => {
  it("opens a session in front by default", () => {
    expect(command("chat-hub://session/abc")).toEqual({
      kind: "session",
      sessionId: "abc",
      window: "front",
    })
  })

  it("honours window=new and window=front", () => {
    expect(command("chat-hub://session/abc?window=new")).toMatchObject({
      window: "new",
    })
    expect(command("chat-hub://session/abc?window=front")).toMatchObject({
      window: "front",
    })
  })

  it("decodes a percent-encoded session id", () => {
    expect(command("chat-hub://session/a%20b%2Fc")).toMatchObject({
      sessionId: "a b/c",
    })
  })

  it("round-trips the link the sidebar copies", () => {
    const id = "session with spaces/and slash"
    expect(command(sessionDeepLink(id))).toEqual({
      kind: "session",
      sessionId: id,
      window: "front",
    })
  })

  it("maps arrange presets", () => {
    expect(command("chat-hub://arrange/review")).toEqual({
      kind: "arrange",
      preset: "review",
    })
    expect(command("chat-hub://arrange/deep-work/")).toEqual({
      kind: "arrange",
      preset: "deep-work",
    })
  })

  it("parses new with an optional project and prompt", () => {
    expect(
      command("chat-hub://new?project=%2FUsers%2Fme%2Fapp&prompt=Fix%20the%20build"),
    ).toEqual({ kind: "new", project: "/Users/me/app", prompt: "Fix the build" })
    expect(command("chat-hub://new")).toEqual({
      kind: "new",
      project: null,
      prompt: null,
    })
  })

  it("parses surface with its session", () => {
    expect(command("chat-hub://surface/editor?session=s-1")).toEqual({
      kind: "surface",
      surface: "editor",
      sessionId: "s-1",
    })
  })

  it("is case-insensitive on the scheme and route only", () => {
    expect(command("CHAT-HUB://Session/AbC")).toMatchObject({ sessionId: "AbC" })
  })

  it.each([
    ["https://example.com/session/abc", "Not a chat-hub:// link"],
    ["chat-hub://", "Unknown route"],
    ["chat-hub://nope/abc", "Unknown route"],
    ["chat-hub://session", "exactly one session id"],
    ["chat-hub://session/", "exactly one session id"],
    ["chat-hub://session/a/b", "exactly one session id"],
    ["chat-hub://session/%E0%A4%A", "percent-encoding"],
    ["chat-hub://session/abc?window=sideways", '"window" must be'],
    ["chat-hub://arrange/cosy", "Unknown preset"],
    ["chat-hub://arrange", "exactly one preset"],
    ["chat-hub://new/extra", "query parameters only"],
    ["chat-hub://surface/diff", '"session" query parameter'],
    ["chat-hub://surface/board?session=s-1", "Unknown panel"],
    ["", "Not a chat-hub:// link"],
  ])("rejects %s", (raw, reason) => {
    expect(error(raw)).toContain(reason)
  })

  it("names every route in the unknown-route error", () => {
    const reason = error("chat-hub://nope")
    for (const route of DEEP_LINK_ROUTES) expect(reason).toContain(route)
  })
})

describe("deep link discovery", () => {
  it("recognises the scheme regardless of case", () => {
    expect(isDeepLink("chat-hub://x")).toBe(true)
    expect(isDeepLink("Chat-Hub://x")).toBe(true)
    expect(isDeepLink("chat-hub:x")).toBe(false)
    expect(isDeepLink("http://chat-hub")).toBe(false)
  })

  it("picks the link out of a second-instance argv", () => {
    const argv = ["/usr/bin/chat-hub", "--no-sandbox", "chat-hub://arrange/review"]
    expect(deepLinkFromArgv(argv)).toBe("chat-hub://arrange/review")
    expect(deepLinkFromArgv(["/usr/bin/chat-hub"])).toBeNull()
  })
})

describe("hubRequestFor", () => {
  it("maps each route onto exactly one hub op", () => {
    expect(
      hubRequestFor({ kind: "session", sessionId: "s", window: "new" }),
    ).toMatchObject({ op: HUB_OPS.openWindow, params: { sessionId: "s" } })
    expect(
      hubRequestFor({ kind: "session", sessionId: "s", window: "front" }),
    ).toMatchObject({ op: HUB_OPS.focusSession, params: { sessionId: "s" } })
    expect(hubRequestFor({ kind: "arrange", preset: "monitor" })).toMatchObject({
      op: HUB_OPS.arrange,
      params: { preset: "monitor" },
    })
    expect(
      hubRequestFor({ kind: "surface", surface: "diff", sessionId: "s" }),
    ).toMatchObject({
      op: HUB_OPS.openSurface,
      params: { sessionId: "s", surface: "diff" },
    })
  })

  it("gives every request a fresh id", () => {
    const a = hubRequestFor({ kind: "arrange", preset: "review" })
    const b = hubRequestFor({ kind: "arrange", preset: "review" })
    expect(a.id).not.toBe(b.id)
  })
})

type Harness = {
  dispatcher: DeepLinkDispatcher
  requests: HubRequest[]
  created: DeepLinkNewSession[]
  warnings: string[]
}

function harness(overrides: Partial<DeepLinkDeps> = {}): Harness {
  const requests: HubRequest[] = []
  const created: DeepLinkNewSession[] = []
  const warnings: string[] = []
  const dispatcher = new DeepLinkDispatcher({
    hub: (request) => {
      requests.push(request)
      return Promise.resolve<HubResponse>({
        id: request.id,
        ok: true,
        result: { summary: request.op },
      })
    },
    newSession: (input) => {
      created.push(input)
      return Promise.resolve<HubResponse>({
        id: "new",
        ok: true,
        result: { summary: "started" },
      })
    },
    warn: (reason) => {
      warnings.push(reason)
    },
    ...overrides,
  })
  return { dispatcher, requests, created, warnings }
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("DeepLinkDispatcher", () => {
  it("sends hub routes through the hub and new through session creation", async () => {
    const h = harness()
    h.dispatcher.markReady()
    await h.dispatcher.run("chat-hub://session/s-1?window=new")
    await h.dispatcher.run("chat-hub://new?project=%2Ftmp%2Fapp&prompt=hello")
    expect(h.requests.map((r) => r.op)).toEqual([HUB_OPS.openWindow])
    expect(h.created).toEqual([{ kind: "new", project: "/tmp/app", prompt: "hello" }])
    expect(h.warnings).toEqual([])
  })

  it("logs a reason and calls nothing for a bad link", async () => {
    const h = harness()
    h.dispatcher.markReady()
    expect(await h.dispatcher.run("chat-hub://arrange/cosy")).toBeNull()
    expect(h.requests).toEqual([])
    expect(h.created).toEqual([])
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain("Unknown preset")
  })

  it("logs the hub's own refusal", async () => {
    const h = harness({
      hub: (request) =>
        Promise.resolve({ id: request.id, ok: false, error: "no such session" }),
    })
    h.dispatcher.markReady()
    const response = await h.dispatcher.run("chat-hub://session/ghost")
    expect(response?.ok).toBe(false)
    expect(h.warnings[0]).toContain("no such session")
  })

  it("queues links that arrive before ready and replays them in order", async () => {
    const h = harness()
    h.dispatcher.open("chat-hub://arrange/review")
    h.dispatcher.open("chat-hub://session/s-2")
    await settled()
    expect(h.requests).toEqual([])

    h.dispatcher.markReady()
    await settled()
    expect(h.requests.map((r) => r.op)).toEqual([
      HUB_OPS.arrange,
      HUB_OPS.focusSession,
    ])
  })

  it("runs links straight away once ready", async () => {
    const h = harness()
    h.dispatcher.markReady()
    h.dispatcher.open("chat-hub://surface/terminal?session=s-1")
    await settled()
    expect(h.requests.map((r) => r.op)).toEqual([HUB_OPS.openSurface])
  })
})

describe("deepLinkPromptPreview", () => {
  it("flattens whitespace and keeps short prompts whole", () => {
    expect(deepLinkPromptPreview("  fix\n\nthe   build ")).toBe("fix the build")
  })

  it("caps long prompts with an ellipsis", () => {
    const preview = deepLinkPromptPreview("x".repeat(1000))
    expect(preview).toHaveLength(DEEP_LINK_PROMPT_PREVIEW_CHARS)
    expect(preview.endsWith("…")).toBe(true)
  })
})
