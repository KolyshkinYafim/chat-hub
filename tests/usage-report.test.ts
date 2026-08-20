import { describe, expect, it } from "vitest"

import type { SessionMeta, SessionUsage, UsageLedgerEntry } from "../src/shared/types"
import {
  axisTicks,
  buildDaySeries,
  cacheStats,
  comparePeriods,
  dayKeysEnding,
  defaultMetric,
  deltaRatio,
  formatAxisValue,
  formatDayFull,
  formatDayTick,
  formatDelta,
  formatUsdWide,
  groupEntries,
  niceMax,
  perTurn,
  previousDayKeys,
  tickIndices,
  topSessions,
  totalsForDays,
} from "@renderer/lib/usage-report"

const NOW = new Date(2026, 7, 19, 12).getTime()

function entry(patch: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    day: "2026-08-19",
    provider: "claude",
    model: "opus",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd: 0,
    turns: 1,
    ...patch,
  }
}

function session(patch: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    title: `Session ${patch.id}`,
    project: "orbit",
    provider: "claude",
    cwd: "/tmp/orbit",
    status: "idle",
    createdAt: NOW - 600_000,
    updatedAt: NOW - 60_000,
    ...patch,
  }
}

describe("day windows", () => {
  it("ends on today and runs oldest first", () => {
    expect(dayKeysEnding(NOW, 3)).toEqual(["2026-08-17", "2026-08-18", "2026-08-19"])
  })

  it("puts the previous window immediately before the current one", () => {
    const current = dayKeysEnding(NOW, 7)
    const previous = previousDayKeys(NOW, 7)
    expect(previous).toHaveLength(7)
    expect(previous[previous.length - 1]).toBe("2026-08-12")
    expect(current[0]).toBe("2026-08-13")
    expect(previous.some((d) => current.includes(d))).toBe(false)
  })

  it("crosses a month boundary by calendar, not by subtracting 24h", () => {
    const march = new Date(2026, 2, 2, 12).getTime()
    expect(dayKeysEnding(march, 4)).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ])
  })
})

describe("totalsForDays", () => {
  it("sums only the days asked for, cache included", () => {
    const entries = [
      entry({ day: "2026-08-19", inputTokens: 10, cacheReadTokens: 900, costUsd: 1 }),
      entry({ day: "2026-08-18", inputTokens: 5, cacheCreateTokens: 40, costUsd: 2 }),
      entry({ day: "2026-08-01", inputTokens: 999, costUsd: 99 }),
    ]
    expect(totalsForDays(entries, dayKeysEnding(NOW, 2))).toEqual({
      inputTokens: 15,
      outputTokens: 0,
      cacheReadTokens: 900,
      cacheCreateTokens: 40,
      costUsd: 3,
      turns: 2,
    })
  })
})

describe("groupEntries", () => {
  const entries = [
    entry({ provider: "claude", costUsd: 5, inputTokens: 10 }),
    entry({ provider: "codex", costUsd: 3, inputTokens: 900 }),
    entry({ provider: "grok", costUsd: 2, inputTokens: 20 }),
    entry({ provider: "opencode", costUsd: 1, inputTokens: 30 }),
  ]

  it("orders by the chosen metric", () => {
    expect(groupEntries(entries, "provider", 8, "cost").map((g) => g.label)).toEqual([
      "claude",
      "codex",
      "grok",
      "opencode",
    ])
    expect(groupEntries(entries, "provider", 8, "tokens").map((g) => g.label)).toEqual([
      "codex",
      "opencode",
      "grok",
      "claude",
    ])
  })

  it("folds everything past the limit into one 'other' row", () => {
    const groups = groupEntries(entries, "provider", 2, "cost")
    expect(groups.map((g) => g.label)).toEqual(["claude", "codex", "other"])
    expect(groups[2].costUsd).toBe(3)
    expect(groups[2].turns).toBe(2)
  })

  it("groups by model when asked", () => {
    const groups = groupEntries(
      [entry({ model: "opus", costUsd: 1 }), entry({ model: "sonnet", costUsd: 4 })],
      "model",
      8,
      "cost",
    )
    expect(groups.map((g) => g.label)).toEqual(["sonnet", "opus"])
  })
})

describe("buildDaySeries", () => {
  const entries = [
    entry({ day: "2026-08-19", provider: "claude", costUsd: 3, inputTokens: 100 }),
    entry({ day: "2026-08-19", provider: "codex", costUsd: 1, inputTokens: 50 }),
    entry({ day: "2026-08-17", provider: "claude", costUsd: 2, inputTokens: 10 }),
    entry({ day: "2026-07-01", provider: "claude", costUsd: 99, inputTokens: 9999 }),
  ]

  it("zero-fills quiet days so the axis keeps a constant scale", () => {
    const series = buildDaySeries(entries, NOW, 3, "provider", "cost")
    expect(series.points.map((p) => p.day)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
    ])
    expect(series.points[1].total).toBe(0)
    expect(series.points[1].turns).toBe(0)
  })

  it("drops entries outside the window and tops out at the busiest day", () => {
    const series = buildDaySeries(entries, NOW, 3, "provider", "cost")
    expect(series.max).toBe(4)
    expect(series.points.reduce((s, p) => s + p.costUsd, 0)).toBe(6)
  })

  it("aligns every day's slices with the legend order", () => {
    const series = buildDaySeries(entries, NOW, 3, "provider", "cost")
    expect(series.keys).toEqual(["claude", "codex"])
    for (const point of series.points) {
      expect(point.slices.map((s) => s.key)).toEqual(series.keys)
    }
    expect(series.points[2].slices).toEqual([
      { key: "claude", value: 3 },
      { key: "codex", value: 1 },
    ])
  })

  it("routes providers past the cap into the 'other' slice", () => {
    const crowded = [
      entry({ day: "2026-08-19", provider: "a", costUsd: 10 }),
      entry({ day: "2026-08-19", provider: "b", costUsd: 5 }),
      entry({ day: "2026-08-19", provider: "c", costUsd: 2 }),
      entry({ day: "2026-08-19", provider: "d", costUsd: 1 }),
    ]
    const series = buildDaySeries(crowded, NOW, 1, "provider", "cost", 2)
    expect(series.keys).toEqual(["a", "b", "other"])
    expect(series.points[0].slices[2]).toEqual({ key: "other", value: 3 })
    expect(series.max).toBe(18)
  })

  it("stacks tokens rather than cost when the metric says so", () => {
    const series = buildDaySeries(entries, NOW, 3, "provider", "tokens")
    expect(series.points[2].slices).toEqual([
      { key: "claude", value: 100 },
      { key: "codex", value: 50 },
    ])
    expect(series.max).toBe(150)
  })

  it("reports an empty range as a flat zero series, not an empty array", () => {
    const series = buildDaySeries([], NOW, 5, "provider", "cost")
    expect(series.points).toHaveLength(5)
    expect(series.keys).toEqual([])
    expect(series.max).toBe(0)
  })
})

describe("comparePeriods", () => {
  it("measures this window against the one before it", () => {
    const entries = [
      entry({ day: "2026-08-19", costUsd: 6, inputTokens: 100, turns: 3 }),
      entry({ day: "2026-08-16", costUsd: 3, inputTokens: 50, turns: 1 }),
    ]
    const cmp = comparePeriods(entries, NOW, 3)
    expect(cmp.current.costUsd).toBe(6)
    expect(cmp.previous.costUsd).toBe(3)
    expect(cmp.costDelta).toBe(1)
    expect(cmp.turnDelta).toBe(2)
  })

  it("has no delta to report when the earlier window was empty", () => {
    const cmp = comparePeriods([entry({ costUsd: 5 })], NOW, 3)
    expect(cmp.costDelta).toBeNull()
    expect(deltaRatio(5, 0)).toBeNull()
  })
})

describe("cacheStats", () => {
  it("reads the cached share of prompt tokens", () => {
    const stats = cacheStats({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 9000,
      cacheCreateTokens: 200,
      costUsd: 1,
      turns: 2,
    })
    expect(stats).toEqual({
      cacheReadTokens: 9000,
      cacheCreateTokens: 200,
      freshInputTokens: 1000,
      hitRatio: 0.9,
    })
  })

  it("stays null when nothing reported cache counts, so no 0% is shown", () => {
    expect(
      cacheStats({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 1,
        turns: 1,
      }),
    ).toBeNull()
  })
})

describe("perTurn", () => {
  it("averages over the turns that ran", () => {
    expect(
      perTurn({
        inputTokens: 800,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 5,
        turns: 4,
      }),
    ).toEqual({ costUsd: 1.25, tokens: 250 })
  })

  it("returns null rather than dividing by no turns", () => {
    expect(
      perTurn({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        costUsd: 0,
        turns: 0,
      }),
    ).toBeNull()
  })
})

describe("topSessions", () => {
  const sessions = [
    session({ id: "s1", title: "Auth refactor", model: "opus" }),
    session({ id: "s2", title: "Webhook retries", provider: "codex" }),
    session({ id: "s3", title: "Reward curve", provider: "grok" }),
  ]
  const usage: Record<string, SessionUsage> = {
    s1: { turns: 10, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 90_000, costUsd: 7.5 },
    s2: { turns: 4, inputTokens: 400, outputTokens: 100, costUsd: 2.5 },
  }

  it("ranks by spend and reports each session's share", () => {
    const rows = topSessions(sessions, usage, 5)
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"])
    expect(rows[0].share).toBeCloseTo(0.75)
    expect(rows[1].share).toBeCloseTo(0.25)
    expect(rows[0].tokens).toBe(1200)
    expect(rows[0].cacheReadTokens).toBe(90_000)
  })

  it("honours the limit", () => {
    expect(topSessions(sessions, usage, 1)).toHaveLength(1)
  })

  it("ranks by tokens when no session was costed", () => {
    const free: Record<string, SessionUsage> = {
      s1: { turns: 1, inputTokens: 10 },
      s2: { turns: 1, inputTokens: 900 },
    }
    expect(topSessions(sessions, free, 5).map((r) => r.id)).toEqual(["s2", "s1"])
  })

  it("skips sessions the ledger never saw", () => {
    expect(topSessions(sessions, usage, 5).some((r) => r.id === "s3")).toBe(false)
  })
})

describe("axis helpers", () => {
  it("rounds the axis top to a readable step", () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(0.7)).toBe(1)
    expect(niceMax(3.2)).toBe(5)
    expect(niceMax(12)).toBe(20)
    expect(niceMax(64_000)).toBe(100_000)
  })

  it("spreads ticks from zero to the rounded top", () => {
    expect(axisTicks(3.2, 2)).toEqual([0, 2.5, 5])
  })

  it("keeps the first and last day labelled and never repeats a slot", () => {
    expect(tickIndices(3, 6)).toEqual([0, 1, 2])
    const ticks = tickIndices(90, 6)
    expect(ticks[0]).toBe(0)
    expect(ticks[ticks.length - 1]).toBe(89)
    expect(new Set(ticks).size).toBe(ticks.length)
  })
})

describe("formatting", () => {
  it("labels days without shifting time zones", () => {
    expect(formatDayTick("2026-08-04")).toBe("Aug 4")
    expect(formatDayFull("2026-08-04")).toBe("Tue, Aug 4")
    expect(formatDayTick("nonsense")).toBe("nonsense")
  })

  it("separates thousands in headline amounts", () => {
    expect(formatUsdWide(1234.5)).toBe("$1,234.50")
    expect(formatUsdWide(0.004)).toBe("<$0.01")
    expect(formatUsdWide(0)).toBe("$0.00")
  })

  it("drops cents from gridline labels that do not need them", () => {
    expect(formatAxisValue(0, "cost")).toBe("$0")
    expect(formatAxisValue(0.25, "cost")).toBe("$0.25")
    expect(formatAxisValue(42.4, "cost")).toBe("$42")
    expect(formatAxisValue(12_000, "tokens")).toBe("12k")
  })

  it("signs the period delta and names a flat one", () => {
    expect(formatDelta(0.42)).toBe("+42%")
    expect(formatDelta(-0.132)).toBe("-13%")
    expect(formatDelta(0)).toBe("no change")
    expect(formatDelta(null)).toBeNull()
  })

  it("only calls cost the default metric when something was costed", () => {
    expect(defaultMetric([entry({ costUsd: 0 })])).toBe("tokens")
    expect(defaultMetric([entry({ costUsd: 0.01 })])).toBe("cost")
  })
})
