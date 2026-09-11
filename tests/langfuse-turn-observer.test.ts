import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AdapterCallbacks } from "../src/main/adapters/types"
import type { ChatMessage, SessionMeta } from "../src/shared/types"
import type { NotificationService } from "../src/main/notifications"

vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

const { turns, adapter } = vi.hoisted(() => {
  const turns: { sessionId: string; prompt: string; callbacks: AdapterCallbacks; resolve: () => void; reject: (error: Error) => void }[] = []
  const adapter = {
    id: "mock", available: true,
    start: async () => {},
    send: (sessionId: string, prompt: string, callbacks: AdapterCallbacks) => {
      callbacks.onSessionEvent({ type: "session.status", id: sessionId, status: "running" })
      return new Promise<void>((resolve, reject) => { turns.push({ sessionId, prompt, callbacks, resolve, reject }) })
    },
    abort: async () => {}, dispose: async () => {},
  }
  return { turns, adapter }
})
vi.mock("../src/main/adapters", () => ({ getAdapter: () => adapter, listAdapters: () => [adapter], refreshProviders: () => {}, listProviderInfo: () => [] }))

const { SessionManager } = await import("../src/main/session-manager")
const { EventBus } = await import("../src/main/event-bus")
const { Persistence } = await import("../src/main/persistence")
const { SessionMonitorBridge } = await import("../src/main/bridge")
const { SettingsStore } = await import("../src/main/settings")
const { turnSpan } = await import("../src/main/langfuse-exporter")

type Observer = (session: SessionMeta, messages: ChatMessage[], userMessageId: string, failed: boolean) => void
const cleanup: (() => Promise<void>)[] = []

async function makeManager(observer: Observer) {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-turn-observer-"))
  const settings = new SettingsStore(join(dir, "settings.json"))
  await settings.load()
  const manager = new SessionManager(new EventBus(), new Persistence(join(dir, "state.json")), new SessionMonitorBridge(join(dir, "events.jsonl")), { handle: () => {} } as unknown as NotificationService, settings, { intervalMs: 60_000, silenceMs: 60_000 }, { titleGenerator: async () => null, onTurnComplete: observer })
  await manager.init()
  cleanup.push(async () => { await manager.shutdown(); await rm(dir, { recursive: true, force: true }) })
  const session = await manager.createSession({ provider: "mock", cwd: dir })
  return { manager, session }
}
function answer(index: number, text: string) {
  const turn = turns[index]
  turn.callbacks.onMessage({ id: `reply-${index}`, sessionId: turn.sessionId, role: "assistant", content: text, createdAt: Date.now(), usage: { inputTokens: 10, outputTokens: index + 1 } })
}
function texts(messages: ChatMessage[]) { return messages.map((message) => message.content) }
function attr(span: ReturnType<typeof turnSpan>, key: string) { return span?.attributes.find((entry) => entry.key === key)?.value.stringValue }

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  turns.length = 0
  vi.restoreAllMocks()
})

describe("turn completion observer", () => {
  it("pairs late replies with their dispatched prompt even when follow-ups were already queued", async () => {
    const observer = vi.fn<Observer>()
    const { manager, session } = await makeManager(observer)
    await manager.sendMessage(session.id, "first prompt")
    await manager.sendMessage(session.id, "queued second prompt")
    await manager.sendMessage(session.id, "queued third prompt")
    answer(0, "first answer")
    turns[0].resolve()
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    expect(observer).toHaveBeenCalledTimes(1)
    const first = observer.mock.calls[0]
    expect(texts(first[1])).toEqual(["first prompt", "first answer"])
    const firstSpan = turnSpan(...first, false)!
    expect(attr(firstSpan, "langfuse.observation.output")).toBe(JSON.stringify("first answer"))

    answer(1, "second answer")
    turns[1].resolve()
    await vi.waitFor(() => expect(turns).toHaveLength(3))
    expect(observer).toHaveBeenCalledTimes(2)
    const second = observer.mock.calls[1]
    expect(texts(second[1])).toEqual(["queued second prompt", "second answer"])
    expect(second[2]).not.toBe(first[2])
    const secondSpan = turnSpan(...second, false)!
    expect(secondSpan.traceId).toBe(firstSpan.traceId)
    expect(secondSpan.spanId).not.toBe(firstSpan.spanId)
    expect(attr(secondSpan, "langfuse.observation.usage_details")).toContain('"output":2')

    answer(2, "third answer")
    turns[2].resolve()
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(3))
    expect(turns.map((turn) => turn.prompt)).toEqual(["first prompt", "queued second prompt", "queued third prompt"])
    expect(texts(observer.mock.calls[2][1])).toEqual(["queued third prompt", "third answer"])
  })

  it("follows dispatch order after the owner reorders queued follow-ups", async () => {
    const observer = vi.fn<Observer>()
    const { manager, session } = await makeManager(observer)
    await manager.sendMessage(session.id, "active")
    await manager.sendMessage(session.id, "queued earlier")
    await manager.sendMessage(session.id, "queued later")
    const queue = manager.listQueued(session.id)
    manager.reorderQueued(session.id, queue[1].id, "up")
    turns[0].resolve()
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    expect(turns[1].prompt).toBe("queued later")
    answer(1, "later task answer")
    turns[1].resolve()
    await vi.waitFor(() => expect(turns).toHaveLength(3))
    expect(texts(observer.mock.calls[1][1])).toEqual(["queued later", "later task answer"])
    expect(turns[2].prompt).toBe("queued earlier")
    answer(2, "earlier task answer")
    turns[2].resolve()
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(3))
    expect(texts(observer.mock.calls[2][1])).toEqual(["queued earlier", "earlier task answer"])
  })

  it("ignores a stopped turn's late completion while a newer turn is running", async () => {
    const observer = vi.fn<Observer>()
    const { manager, session } = await makeManager(observer)
    await manager.sendMessage(session.id, "stopped prompt")
    await manager.abortSession(session.id)
    await manager.sendMessage(session.id, "new prompt")
    turns[0].resolve()
    await Promise.resolve()
    expect(observer).not.toHaveBeenCalled()
    expect(manager.getSession(session.id)?.status).toBe("running")
    answer(1, "new answer")
    turns[1].resolve()
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1))
    expect(texts(observer.mock.calls[0][1])).toEqual(["new prompt", "new answer"])
  })

  it("reports rejected turns once without attributing queued text or a previous reply", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const observer = vi.fn<Observer>()
    const { manager, session } = await makeManager(observer)
    await manager.sendMessage(session.id, "working prompt")
    answer(0, "previous successful answer")
    turns[0].resolve()
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1))
    await manager.sendMessage(session.id, "failing prompt")
    await manager.sendMessage(session.id, "never dispatched")
    turns[1].reject(new Error("CLI failed"))
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(2))
    const failure = observer.mock.calls[1]
    expect(failure[3]).toBe(true)
    expect(texts(failure[1])).toEqual(["failing prompt"])
    const span = turnSpan(...failure, false)!
    expect(span.status.code).toBe(2)
    expect(attr(span, "langfuse.observation.output")).toBe('""')
    expect(turns).toHaveLength(2)
  })

  it("recognizes adapters that resolve after emitting an error status", async () => {
    const observer = vi.fn<Observer>()
    const { manager, session } = await makeManager(observer)
    await manager.sendMessage(session.id, "fail with status")
    answer(0, "partial answer")
    turns[0].callbacks.onSessionEvent({ type: "session.status", id: session.id, status: "error" })
    turns[0].resolve()
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1))
    expect(observer.mock.calls[0][3]).toBe(true)
    expect(texts(observer.mock.calls[0][1])).toEqual(["fail with status", "partial answer"])
  })

  it("keeps queue dispatch working if the observer throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const observer = vi.fn<Observer>().mockImplementation(() => { throw new Error("observer failed") })
    const { manager, session } = await makeManager(observer)
    await manager.sendMessage(session.id, "first")
    await manager.sendMessage(session.id, "follow-up")
    answer(0, "done")
    turns[0].resolve()
    await vi.waitFor(() => expect(turns).toHaveLength(2))
    expect(turns[1].prompt).toBe("follow-up")
    turns[1].resolve()
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(2))
    expect(manager.getSession(session.id)?.status).toBe("idle")
  })
})
