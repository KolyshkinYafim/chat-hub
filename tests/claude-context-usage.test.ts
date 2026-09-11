import { describe, expect, it, vi } from "vitest"
import type { AdapterCallbacks } from "../src/main/adapters/types"
import type { RunSpec } from "../src/main/adapters/process-runner"

const fixture = vi.hoisted(() => ({ events: [] as Record<string, unknown>[] }))
vi.mock("../src/main/adapters/binary", () => ({ findBinary: () => "/test/claude", isExecutable: () => true }))
vi.mock("../src/main/adapters/process-runner", () => ({
  runProcess: (spec: RunSpec) => {
    const done = Promise.resolve().then(() => {
      for (const event of fixture.events) spec.onStdoutLine?.(JSON.stringify(event))
      spec.onExit?.(0, null)
      return { code: 0, signal: null }
    })
    return { pid: 123, abort: () => {}, done }
  },
}))
import { ClaudeAdapter } from "../src/main/adapters/claude"

const request = (input: number, read: number) => ({ type: "stream_event", event: { type: "message_start", message: { id: `message-${input}`, usage: { input_tokens: input, cache_read_input_tokens: read } } } })
const result = { type: "result", result: "Done", usage: { input_tokens: 2100, cache_read_input_tokens: 1_100_000, output_tokens: 9000 }, total_cost_usd: 0.6, modelUsage: { "claude-fable-5": { contextWindow: 1_000_000 } } }

async function replay(events: Record<string, unknown>[]) {
  fixture.events = events
  const callbacks: AdapterCallbacks = {
    onSessionEvent: vi.fn(), onMessage: vi.fn(), onDelta: vi.fn(), onStreamDone: vi.fn(), onTurnItem: vi.fn(), onUsage: vi.fn(),
  }
  const adapter = new ClaudeAdapter()
  await adapter.start({ sessionId: "s", cwd: "/tmp" }, callbacks)
  await adapter.send("s", "work", callbacks)
  return vi.mocked(callbacks.onUsage!).mock.calls[0]?.[1]
}

describe("Claude adapter context usage", () => {
  it("emits latest request context separately from cumulative result billing", async () => {
    const usage = await replay([request(100, 40_000), request(200, 46_000), { ...request(300, 180_000), parent_tool_use_id: "subagent" }, result])
    expect(usage).toMatchObject({ contextUsedTokens: 46_200, inputTokens: 2100, cacheReadTokens: 1_100_000, outputTokens: 9000, costUsd: 0.6, contextWindow: 1_000_000 })
  })
  it("reports unknown context when only a result or an incomplete latest request is available", async () => {
    expect((await replay([result]))?.contextUsedTokens).toBeUndefined()
    expect((await replay([request(100, 40_000), { type: "stream_event", event: { type: "message_start", message: {} } }, result]))?.contextUsedTokens).toBeUndefined()
  })
  it("takes the completed main assistant request snapshot even after a result envelope", async () => {
    const usage = await replay([request(100, 40_000), result, { type: "assistant", message: { content: [], usage: { input_tokens: 200, cache_read_input_tokens: 47_000, cache_creation_input_tokens: 500 } } }])
    expect(usage?.contextUsedTokens).toBe(47_700)
    expect(usage?.costUsd).toBe(0.6)
  })
})
