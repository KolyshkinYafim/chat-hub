import { describe, expect, it } from "vitest"
import {
  buildTurnTimeline,
  cleanSummary,
  formatTiming,
  unfinishedLabel,
} from "@renderer/lib/turn-timeline"
import type { AgentTurnItem } from "@shared/types"

const reasoning = (summary: string, id = "r1"): AgentTurnItem => ({
  id,
  kind: "reasoning",
  status: "completed",
  summary,
})

const shell = (
  id: string,
  status: AgentTurnItem["status"],
  command: string,
  durationMs?: number,
): AgentTurnItem => ({ id, kind: "command", status, command, durationMs })

describe("buildTurnTimeline", () => {
  it("numbers the steps in arrival order", () => {
    const timeline = buildTurnTimeline([
      shell("a", "completed", "pnpm install"),
      shell("b", "completed", "pnpm test"),
      shell("c", "running", "pnpm lint"),
    ])
    expect(timeline.rows.map((row) => row.index)).toEqual([1, 2, 3])
    expect(timeline.rows.map((row) => row.id)).toEqual(["a", "b", "c"])
    expect(timeline.total).toBe(3)
    expect(timeline.done).toBe(2)
  })

  it("keeps reasoning out of the sequence and uses it as the summary", () => {
    const timeline = buildTurnTimeline([
      reasoning("Reproducing the failure before touching the guard"),
      shell("a", "running", "pnpm test"),
    ])
    expect(timeline.rows).toHaveLength(1)
    expect(timeline.rows[0]!.index).toBe(1)
    expect(timeline.summary).toBe(
      "Reproducing the failure before touching the guard",
    )
  })

  it("prefers the newest reasoning summary but keeps them all", () => {
    const timeline = buildTurnTimeline([
      reasoning("first pass", "r1"),
      shell("a", "completed", "pnpm test"),
      reasoning("second pass", "r2"),
    ])
    expect(timeline.summary).toBe("second pass")
    expect(timeline.reasoning).toEqual(["first pass", "second pass"])
  })

  it("drops a summary a provider repeated verbatim", () => {
    const timeline = buildTurnTimeline([
      reasoning("same thought", "r1"),
      reasoning("same thought", "r2"),
      reasoning("a new thought", "r3"),
    ])
    expect(timeline.reasoning).toEqual(["same thought", "a new thought"])
  })

  it("falls back to the turn's own first prose line", () => {
    const timeline = buildTurnTimeline(
      [shell("a", "running", "pnpm test")],
      "## Release readiness\n\nThe auth path is green.",
    )
    expect(timeline.summary).toBe("Release readiness")
  })

  it("skips a fenced opening line when falling back", () => {
    const timeline = buildTurnTimeline([], "```bash\npnpm test\n```")
    expect(timeline.summary).toBe("pnpm test")
  })

  it("points at the running step, not at a queued one after it", () => {
    const timeline = buildTurnTimeline([
      shell("a", "completed", "pnpm install"),
      shell("b", "running", "pnpm test"),
      shell("c", "pending", "pnpm lint"),
    ])
    expect(timeline.activeIndex).toBe(2)
  })

  it("points at the first queued step when nothing is running yet", () => {
    const timeline = buildTurnTimeline([
      shell("a", "completed", "pnpm install"),
      shell("b", "pending", "pnpm test"),
      shell("c", "pending", "pnpm lint"),
    ])
    expect(timeline.activeIndex).toBe(2)
  })

  it("has no active step once the turn is finished", () => {
    const timeline = buildTurnTimeline([
      shell("a", "completed", "pnpm install"),
      shell("b", "failed", "pnpm test"),
    ])
    expect(timeline.activeIndex).toBeNull()
    expect(timeline.failed).toBe(1)
  })

  it("counts declined and interrupted steps as failures", () => {
    const timeline = buildTurnTimeline([
      shell("a", "declined", "rm -rf /"),
      shell("b", "interrupted", "pnpm test"),
    ])
    expect(timeline.failed).toBe(2)
    expect(timeline.rows.map((row) => row.state)).toEqual([
      "declined",
      "stopped",
    ])
  })

  it("labels each kind with what ran and on what", () => {
    const timeline = buildTurnTimeline([
      shell("a", "completed", "/bin/zsh -lc 'pnpm test -- expiry'"),
      {
        id: "b",
        kind: "tool",
        status: "completed",
        name: "mcp__docs__lookup",
        arguments: { query: "exp claim" },
      },
      {
        id: "c",
        kind: "file_change",
        status: "completed",
        changes: [{ path: "src/lib/jwt.ts" }, { path: "src/lib/clock.ts" }],
      },
      { id: "d", kind: "web_search", status: "completed", query: "jwt exp" },
    ])
    expect(timeline.rows.map((row) => [row.label, row.detail])).toEqual([
      ["Shell", "pnpm test -- expiry"],
      ["lookup", "exp claim"],
      ["Edit", "2 files"],
      ["Search", "jwt exp"],
    ])
    expect(timeline.rows[1]!.server).toBe("docs")
  })

  it("carries a provider duration and stays silent without one", () => {
    const timeline = buildTurnTimeline([
      shell("a", "completed", "pnpm test", 4120),
      shell("b", "running", "pnpm lint"),
    ])
    expect(timeline.rows[0]!.timing).toBe("4.1s")
    expect(timeline.rows[1]!.timing).toBeNull()
  })

  it("is empty but well formed for a turn that has not started", () => {
    const timeline = buildTurnTimeline(undefined)
    expect(timeline).toEqual({
      rows: [],
      reasoning: [],
      summary: "",
      activeIndex: null,
      done: 0,
      total: 0,
      failed: 0,
    })
  })

  it("clamps a long detail so a row can never wrap to a second line", () => {
    const timeline = buildTurnTimeline([
      shell("a", "running", "echo " + "x".repeat(400)),
    ])
    expect(timeline.rows[0]!.detail.length).toBeLessThanOrEqual(140)
    expect(timeline.rows[0]!.detail.endsWith("…")).toBe(true)
  })
})

describe("formatTiming", () => {
  it("reports sub-second work in milliseconds", () => {
    expect(formatTiming(180)).toBe("180ms")
    expect(formatTiming(999)).toBe("999ms")
  })

  it("reports the first ten seconds to one decimal", () => {
    expect(formatTiming(1000)).toBe("1.0s")
    expect(formatTiming(4120)).toBe("4.1s")
  })

  it("hands longer runs to the shared elapsed format", () => {
    expect(formatTiming(10_000)).toBe("10s")
    expect(formatTiming(83_000)).toBe("1m 23s")
  })

  it("says nothing when the provider reported nothing usable", () => {
    expect(formatTiming(undefined)).toBeNull()
    expect(formatTiming(Number.NaN)).toBeNull()
    expect(formatTiming(-1)).toBeNull()
  })
})

describe("cleanSummary", () => {
  it("strips the markdown a one-line summary cannot render", () => {
    expect(cleanSummary("**Checking** the `exp` claim")).toBe(
      "Checking the exp claim",
    )
  })

  it("flattens wrapped reasoning onto one line", () => {
    expect(cleanSummary("first line\n   second line")).toBe(
      "first line second line",
    )
  })
})

describe("unfinishedLabel", () => {
  const rowsFor = (...statuses: AgentTurnItem["status"][]) =>
    buildTurnTimeline(
      statuses.map((status, i) => shell(`s${i}`, status, "pnpm test")),
    ).rows

  it("says nothing when every step finished", () => {
    expect(unfinishedLabel(rowsFor("completed", "completed"))).toBeNull()
  })

  it("names one kind of trouble by its own word", () => {
    expect(unfinishedLabel(rowsFor("completed", "declined"))).toBe("1 declined")
    expect(unfinishedLabel(rowsFor("failed", "failed"))).toBe("2 failed")
  })

  it("falls back to a neutral word for mixed trouble", () => {
    expect(unfinishedLabel(rowsFor("failed", "interrupted"))).toBe(
      "2 unfinished",
    )
  })
})
