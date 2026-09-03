import { describe, expect, it } from "vitest"

import { formatTurnMeta } from "../src/renderer/src/lib/usage"

describe("formatTurnMeta", () => {
  it("folds tokens, cost and context share into one line", () => {
    expect(
      formatTurnMeta(
        {
          inputTokens: 5100,
          outputTokens: 890,
          cacheReadTokens: 62100,
          cacheCreateTokens: 2400,
          costUsd: 0.06,
          contextWindow: 200_000,
        },
        "claude-sonnet-4",
      ),
    ).toBe("5.1k in · 890 out · $0.06 · 35% ctx")
  })

  it("hides the context share when no window is known", () => {
    expect(
      formatTurnMeta({ inputTokens: 100, outputTokens: 40 }, "mystery-model"),
    ).toBe("100 in · 40 out")
  })

  it("falls back to the session window when the turn reported none", () => {
    expect(
      formatTurnMeta({ inputTokens: 50_000 }, undefined, 200_000),
    ).toBe("50k in · 25% ctx")
  })

  it("renders sub-cent cost without claiming free", () => {
    expect(formatTurnMeta({ costUsd: 0.004 })).toBe("<$0.01")
  })

  it("returns null when the CLI reported nothing", () => {
    expect(formatTurnMeta({})).toBeNull()
  })

  it("caps the context share at 100%", () => {
    expect(
      formatTurnMeta({ inputTokens: 300_000 }, undefined, 200_000),
    ).toBe("300k in · 100% ctx")
  })
})
