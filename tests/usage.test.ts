import { describe, expect, it } from "vitest"

import { addUsage, readUsage } from "../src/main/adapters/usage"

describe("readUsage", () => {
  it("reads a Claude stream-json result envelope", () => {
    expect(
      readUsage({
        type: "result",
        subtype: "success",
        duration_ms: 4210,
        total_cost_usd: 0.0731,
        usage: {
          input_tokens: 12,
          output_tokens: 480,
          cache_read_input_tokens: 21_500,
          cache_creation_input_tokens: 900,
        },
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 480,
      cacheReadTokens: 21_500,
      cacheCreateTokens: 900,
      costUsd: 0.0731,
      durationMs: 4210,
    })
  })

  it("reads OpenAI-style token names and a nested cache block", () => {
    expect(
      readUsage({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          cache: { read: 8, write: 3 },
        },
        cost: 0.002,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 8,
      cacheCreateTokens: 3,
      costUsd: 0.002,
    })
  })

  it("returns null for a line that carries no numbers, so the chip stays hidden", () => {
    expect(readUsage({ type: "assistant", message: { content: [] } })).toBeNull()
    expect(readUsage({ type: "result", usage: {} })).toBeNull()
  })

  it("ignores non-numeric values rather than folding NaN into the total", () => {
    expect(
      readUsage({ total_cost_usd: null, usage: { output_tokens: "many" } }),
    ).toBeNull()
  })
})

describe("addUsage", () => {
  it("sums turns and counts them", () => {
    const first = addUsage(undefined, { outputTokens: 10, costUsd: 0.5 })
    const second = addUsage(first, { outputTokens: 5, costUsd: 0.25 })
    expect(second).toEqual({ turns: 2, outputTokens: 15, costUsd: 0.75 })
  })

  it("keeps a field the CLI stopped reporting instead of dropping it", () => {
    const first = addUsage(undefined, { costUsd: 1 })
    expect(addUsage(first, { outputTokens: 3 })).toEqual({
      turns: 2,
      costUsd: 1,
      outputTokens: 3,
    })
  })

  it("never invents a field no turn reported", () => {
    expect(addUsage(undefined, { costUsd: 1 })).toEqual({ turns: 1, costUsd: 1 })
  })
})
