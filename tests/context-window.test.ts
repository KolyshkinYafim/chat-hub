import { describe, expect, it } from "vitest"

import {
  contextUsedTokens,
  contextWindowFor,
  formatContextMeter,
  formatTokens,
} from "../src/shared/context-window"
import { readUsage } from "../src/main/adapters/usage"

describe("readUsage context window", () => {
  it("reads the window a Claude result envelope reports under modelUsage", () => {
    const usage = readUsage({
      type: "result",
      subtype: "success",
      duration_ms: 8823,
      total_cost_usd: 0.31,
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 679,
        cache_read_input_tokens: 351_096,
        output_tokens: 180,
      },
      modelUsage: {
        "claude-fable-5": {
          inputTokens: 4,
          outputTokens: 180,
          cacheReadInputTokens: 351_096,
          cacheCreationInputTokens: 679,
          webSearchRequests: 0,
          costUSD: 0.31,
          contextWindow: 1_000_000,
        },
      },
    })
    expect(usage).toEqual({
      inputTokens: 4,
      outputTokens: 180,
      cacheReadTokens: 351_096,
      cacheCreateTokens: 679,
      costUsd: 0.31,
      durationMs: 8823,
      contextWindow: 1_000_000,
    })
  })

  it("picks the window of the model that occupied the most context", () => {
    const usage = readUsage({
      type: "result",
      usage: { input_tokens: 10, output_tokens: 20 },
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: 800,
          cacheReadInputTokens: 4_000,
          contextWindow: 200_000,
        },
        "claude-fable-5": {
          inputTokens: 4,
          cacheReadInputTokens: 351_096,
          cacheCreationInputTokens: 679,
          contextWindow: 1_000_000,
        },
      },
    })
    expect(usage?.contextWindow).toBe(1_000_000)
  })

  it("reports no window when the envelope carries none (codex turn.completed)", () => {
    const usage = readUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 34_054,
        cached_input_tokens: 27_136,
        cache_write_input_tokens: 0,
        output_tokens: 79,
      },
    })
    expect(usage?.contextWindow).toBeUndefined()
    expect(usage).toEqual({
      inputTokens: 34_054,
      outputTokens: 79,
      cacheReadTokens: 27_136,
      cacheCreateTokens: 0,
    })
  })
})

describe("contextUsedTokens", () => {
  it("sums input plus both cache directions of the last turn (claude result)", () => {
    expect(
      contextUsedTokens({
        inputTokens: 4,
        cacheReadTokens: 351_096,
        cacheCreateTokens: 679,
        outputTokens: 180,
      }),
    ).toBe(351_779)
  })

  it("handles a codex app-server last-turn breakdown", () => {
    expect(
      contextUsedTokens({
        inputTokens: 9_000,
        cacheReadTokens: 120_000,
        cacheCreateTokens: 0,
        outputTokens: 500,
        contextWindow: 272_000,
      }),
    ).toBe(129_000)
  })

  it("handles an opencode nested-cache turn as parsed by readUsage", () => {
    const usage = readUsage({
      type: "message.updated",
      usage: {
        prompt_tokens: 2_000,
        completion_tokens: 300,
        cache: { read: 1_500, write: 0 },
      },
    })
    expect(usage).not.toBeNull()
    expect(contextUsedTokens(usage!)).toBe(3_500)
  })

  it("returns null when a turn reported nothing about its input side", () => {
    expect(contextUsedTokens({ outputTokens: 79, costUsd: 0.1 })).toBeNull()
    expect(contextUsedTokens({})).toBeNull()
  })
})

describe("contextWindowFor", () => {
  it("prefers the runtime-reported window over the table", () => {
    expect(contextWindowFor("claude-fable-5", 500_000)).toBe(500_000)
  })

  it("ignores a nonsensical reported window", () => {
    expect(contextWindowFor("claude-fable-5", 0)).toBe(1_000_000)
    expect(contextWindowFor("claude-fable-5", -1)).toBe(1_000_000)
    expect(contextWindowFor("claude-fable-5", Number.NaN)).toBe(1_000_000)
  })

  it("falls back to well-known claude and codex ids", () => {
    expect(contextWindowFor("claude-fable-5", undefined)).toBe(1_000_000)
    expect(contextWindowFor("opus", undefined)).toBe(200_000)
    expect(contextWindowFor("claude-sonnet-4-5", undefined)).toBe(200_000)
    expect(contextWindowFor("gpt-5-codex", undefined)).toBe(272_000)
    expect(contextWindowFor("gpt-5.3", undefined)).toBe(272_000)
  })

  it("never guesses for unknown models or a missing model id", () => {
    expect(contextWindowFor("grok-4", undefined)).toBeNull()
    expect(contextWindowFor("anthropic/claude-sonnet", undefined)).toBeNull()
    expect(contextWindowFor(undefined, undefined)).toBeNull()
  })
})

describe("formatting", () => {
  it("keeps k below the megatoken boundary and rounds up across it", () => {
    expect(formatTokens(940)).toBe("940")
    expect(formatTokens(9_400)).toBe("9.4k")
    expect(formatTokens(351_300)).toBe("351k")
    expect(formatTokens(999_499)).toBe("999k")
    expect(formatTokens(999_500)).toBe("1M")
    expect(formatTokens(1_000_000)).toBe("1M")
    expect(formatTokens(2_400_000)).toBe("2.4M")
  })

  it("builds the meter label from the same formatter", () => {
    expect(formatContextMeter(351_779, 1_000_000)).toEqual({
      label: "352k / 1M · 35%",
      ratio: 0.351779,
    })
  })

  it("clamps the ratio to [0, 1] but keeps the label honest", () => {
    const over = formatContextMeter(1_200_000, 1_000_000)
    expect(over.ratio).toBe(1)
    expect(over.label).toBe("1.2M / 1M · 100%")
    const under = formatContextMeter(0, 200_000)
    expect(under.ratio).toBe(0)
    expect(under.label).toBe("0 / 200k · 0%")
  })
})
