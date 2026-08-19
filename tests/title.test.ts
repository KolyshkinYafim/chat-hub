import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  heuristicTitle,
  looksDefaultTitle,
  sanitizeLlmTitle,
} from "../src/shared/title"
import {
  buildTitleArgs,
  buildTitlePrompt,
  generateTitle,
  parseTitleOutput,
} from "../src/main/title-llm"
import type { HubEvent } from "../src/shared/types"
import type { AdapterCallbacks, AdapterStartOpts } from "../src/main/adapters/types"
import type { NotificationService } from "../src/main/notifications"
import type { TitleGenerator } from "../src/main/session-manager"

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}))

const { adapter, state } = vi.hoisted(() => {
  const state = {
    pending: null as { resolve: () => void; reject: (err: unknown) => void } | null,
  }
  const adapter = {
    id: "mock" as const,
    available: true,
    async start(_opts: AdapterStartOpts, _cb: AdapterCallbacks): Promise<void> {},
    send(
      sessionId: string,
      _message: string,
      cb: AdapterCallbacks,
    ): Promise<void> {
      cb.onSessionEvent({ type: "session.status", id: sessionId, status: "running" })
      return new Promise<void>((resolve, reject) => {
        state.pending = { resolve, reject }
      })
    },
    async abort(): Promise<void> {},
    async dispose(): Promise<void> {},
  }
  return { adapter, state }
})

vi.mock("../src/main/adapters", () => ({
  getAdapter: () => adapter,
  listAdapters: () => [adapter],
  refreshProviders: () => {},
  listProviderInfo: () => [],
}))

const { SessionManager } = await import("../src/main/session-manager")
const { EventBus } = await import("../src/main/event-bus")
const { Persistence } = await import("../src/main/persistence")
const { SessionMonitorBridge } = await import("../src/main/bridge")
const { SettingsStore } = await import("../src/main/settings")

async function makeManager(titleGenerator: TitleGenerator) {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-title-"))
  const persistence = new Persistence(join(dir, "state.json"))
  const settings = new SettingsStore(join(dir, "settings.json"))
  await settings.load()
  const bus = new EventBus()
  const events: HubEvent[] = []
  bus.on((e) => events.push(e))
  const sm = new SessionManager(
    bus,
    persistence,
    new SessionMonitorBridge(join(dir, "events.jsonl")),
    { handle: () => {} } as unknown as NotificationService,
    settings,
    { intervalMs: 60_000, silenceMs: 60_000 },
    { titleGenerator },
  )
  await sm.init()
  return { sm, dir, events }
}

beforeEach(() => {
  state.pending = null
})

describe("heuristicTitle", () => {
  it("takes the first sentence of an English message", () => {
    expect(
      heuristicTitle(
        "Fix the login bug on the settings page. It happens when I toggle dark mode.",
      ),
    ).toBe("Fix the login bug on the settings page")
  })

  it("keeps a Russian message in Russian and capitalizes it", () => {
    expect(heuristicTitle("почини баг с пустой очередью redis")).toBe(
      "Почини баг с пустой очередью redis",
    )
  })

  it("strips code fences before titling", () => {
    expect(
      heuristicTitle("Why does this crash?\n```js\nconst x = null\nx.foo()\n```"),
    ).toBe("Why does this crash")
  })

  it("strips an unterminated code fence", () => {
    expect(heuristicTitle("Review this snippet\n```ts\nlet a = 1")).toBe(
      "Review this snippet",
    )
  })

  it("strips @path mentions", () => {
    expect(
      heuristicTitle("Refactor @src/main/session-manager.ts to split the queue"),
    ).toBe("Refactor to split the queue")
  })

  it("caps long messages at a word boundary under 48 chars", () => {
    const title = heuristicTitle(
      "please investigate why the production deployment pipeline keeps timing out on the second stage every night",
    )
    expect(title).not.toBeNull()
    expect(title!.length).toBeLessThanOrEqual(48)
    expect(title!.endsWith("…")).toBe(true)
  })

  it("caps at 6-8 words even without punctuation", () => {
    const title = heuristicTitle("one two three four five six seven eight nine ten")
    expect(title).toBe("One two three four five six seven eight")
  })

  it("returns null for empty and garbage input", () => {
    expect(heuristicTitle("")).toBeNull()
    expect(heuristicTitle("   ")).toBeNull()
    expect(heuristicTitle("```\nfoo\n```")).toBeNull()
    expect(heuristicTitle("@src/index.ts")).toBeNull()
    expect(heuristicTitle("???")).toBeNull()
    expect(heuristicTitle("--- ***")).toBeNull()
  })
})

describe("looksDefaultTitle", () => {
  it("recognizes defaultTitle() shapes from session-manager", () => {
    expect(looksDefaultTitle("agent-desktop-suite · claude · 14:03")).toBe(true)
    expect(looksDefaultTitle("mary · codex · 09:41")).toBe(true)
    expect(looksDefaultTitle("New · agent-desktop-suite")).toBe(true)
    expect(looksDefaultTitle("")).toBe(true)
  })

  it("treats anything else as a user title", () => {
    expect(looksDefaultTitle("Fix login bug")).toBe(false)
    expect(looksDefaultTitle("Починка очереди Redis")).toBe(false)
    expect(looksDefaultTitle("claude · thoughts")).toBe(false)
  })
})

describe("sanitizeLlmTitle", () => {
  it("strips wrapping quotes", () => {
    expect(sanitizeLlmTitle('"Redis queue fix"')).toBe("Redis queue fix")
    expect(sanitizeLlmTitle("«Починка очереди Redis»")).toBe(
      "Починка очереди Redis",
    )
  })

  it("strips Title prefixes and trailing punctuation", () => {
    expect(sanitizeLlmTitle("Title: Redis queue fix.")).toBe("Redis queue fix")
    expect(sanitizeLlmTitle("Название: Починка очереди!")).toBe(
      "Починка очереди",
    )
  })

  it("rejects rambling answers", () => {
    expect(sanitizeLlmTitle("Here is a title for the session: Fix bug")).toBeNull()
    expect(sanitizeLlmTitle("Sure, how about Fixing The Queue")).toBeNull()
  })

  it("rejects over-length answers", () => {
    expect(sanitizeLlmTitle("word ".repeat(20))).toBeNull()
  })

  it("keeps only the first line of a multiline answer", () => {
    expect(sanitizeLlmTitle("Redis queue fix\nThis captures the topic.")).toBe(
      "Redis queue fix",
    )
  })

  it("rejects empty and symbol-only answers", () => {
    expect(sanitizeLlmTitle("")).toBeNull()
    expect(sanitizeLlmTitle('"..."')).toBeNull()
  })
})

describe("title-llm one-shot", () => {
  it("builds a -p json haiku invocation", () => {
    const args = buildTitleArgs("prompt text")
    expect(args).toEqual([
      "-p",
      "--model",
      "haiku",
      "--output-format",
      "json",
      "prompt text",
    ])
  })

  it("demands language parity and format rules in the prompt", () => {
    const prompt = buildTitlePrompt("почини баг", "готово")
    expect(prompt).toMatch(/3-6 words/)
    expect(prompt).toMatch(/no quotes/)
    expect(prompt).toMatch(/no trailing punctuation/)
    expect(prompt).toMatch(/same language/)
    expect(prompt).toContain("почини баг")
    expect(prompt).toContain("готово")
  })

  it("parses the CLI's {result} JSON line", () => {
    expect(parseTitleOutput('{"result":"Redis queue fix","cost":1}')).toBe(
      "Redis queue fix",
    )
    expect(parseTitleOutput("garbage\nnot json")).toBeNull()
  })

  it("runs through the injected runner and sanitizes the answer", async () => {
    const calls: string[][] = []
    const title = await generateTitle("почини баг", "done", {
      binary: "/fake/claude",
      run: async (_bin, args) => {
        calls.push(args)
        return JSON.stringify({ result: '"Починка очереди."' })
      },
    })
    expect(title).toBe("Починка очереди")
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe("-p")
  })

  it("collapses runner failures and missing binary to null", async () => {
    expect(
      await generateTitle("x", "", {
        binary: "/fake/claude",
        run: async () => {
          throw new Error("timeout")
        },
      }),
    ).toBeNull()
    expect(await generateTitle("x", "", { binary: null })).toBeNull()
  })
})

describe("session auto-titling", () => {
  it("retitles a default-titled session from the first message and publishes upsert", async () => {
    const { sm, dir, events } = await makeManager(async () => null)
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    expect(session.titleOrigin).toBe("default")

    await sm.sendMessage(session.id, "почини баг с пустой очередью redis")

    const meta = sm.getSession(session.id)
    expect(meta?.title).toBe("Почини баг с пустой очередью redis")
    expect(meta?.titleOrigin).toBe("auto")
    expect(
      events.some(
        (e) =>
          e.type === "session.upsert" &&
          e.session.title === "Почини баг с пустой очередью redis",
      ),
    ).toBe(true)
  })

  it("only the first user message retitles; later ones leave the title alone", async () => {
    const { sm, dir } = await makeManager(async () => null)
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "first message about redis")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
    await sm.sendMessage(session.id, "completely different topic now")

    expect(sm.getSession(session.id)?.title).toBe("First message about redis")
  })

  it("never touches a session the user titled in the new-session dialog", async () => {
    const { sm, dir } = await makeManager(async () => "LLM title")
    const session = await sm.createSession({
      provider: "mock",
      cwd: dir,
      title: "My hand-picked name",
    })
    expect(session.titleOrigin).toBe("user")

    await sm.sendMessage(session.id, "some first message")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
    await new Promise((r) => setTimeout(r, 10))

    expect(sm.getSession(session.id)?.title).toBe("My hand-picked name")
  })

  it("refines via the LLM once after the first turn completes", async () => {
    let calls = 0
    const { sm, dir } = await makeManager(async (user) => {
      calls += 1
      expect(user).toBe("fix the flaky retry logic")
      return "Flaky retry fix"
    })
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "fix the flaky retry logic")
    state.pending?.resolve()
    await vi.waitFor(() => {
      const meta = sm.getSession(session.id)
      expect(meta?.title).toBe("Flaky retry fix")
      expect(meta?.titleOrigin).toBe("auto")
    })

    await sm.sendMessage(session.id, "now the second turn")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(1)
  })

  it("keeps the heuristic title when the LLM fails", async () => {
    const { sm, dir } = await makeManager(async () => null)
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "fix the flaky retry logic")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
    await new Promise((r) => setTimeout(r, 10))

    expect(sm.getSession(session.id)?.title).toBe("Fix the flaky retry logic")
  })

  it("a rename that lands while refinement is in flight wins", async () => {
    let release: (v: string | null) => void = () => {}
    const gate = new Promise<string | null>((r) => {
      release = r
    })
    const { sm, dir } = await makeManager(() => gate)
    const session = await sm.createSession({ provider: "mock", cwd: dir })

    await sm.sendMessage(session.id, "fix the flaky retry logic")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))

    const renamed = sm.renameSession(session.id, "Manual name")
    expect(renamed.titleOrigin).toBe("user")

    release("Late LLM title")
    await new Promise((r) => setTimeout(r, 10))
    expect(sm.getSession(session.id)?.title).toBe("Manual name")
  })

  it("regenerate is allowed for a user-renamed session and hands the title back to auto", async () => {
    const { sm, dir } = await makeManager(async () => "Fresh LLM title")
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "fix the flaky retry logic")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))

    sm.renameSession(session.id, "Manual name")

    const meta = await sm.regenerateTitle(session.id)
    expect(meta.title).toBe("Fresh LLM title")
    expect(meta.titleOrigin).toBe("auto")
  })

  it("regenerate keeps the current title when the LLM fails", async () => {
    const { sm, dir } = await makeManager(async () => null)
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    await sm.sendMessage(session.id, "fix the flaky retry logic")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))

    const meta = await sm.regenerateTitle(session.id)
    expect(meta.title).toBe("Fix the flaky retry logic")
  })

  it("treats a restored session with a hand-written title and no origin field as user-owned", async () => {
    const { sm, dir } = await makeManager(async () => "LLM title")
    const session = await sm.createSession({ provider: "mock", cwd: dir })
    const bare = sm.getSession(session.id)!
    delete (bare as { titleOrigin?: string }).titleOrigin
    bare.title = "Legacy custom name"

    await sm.sendMessage(session.id, "first message here")
    state.pending?.resolve()
    await vi.waitFor(() => expect(sm.getSession(session.id)?.status).toBe("idle"))
    await new Promise((r) => setTimeout(r, 10))

    expect(sm.getSession(session.id)?.title).toBe("Legacy custom name")
  })
})
