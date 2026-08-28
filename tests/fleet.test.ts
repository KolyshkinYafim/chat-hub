import { describe, expect, it } from "vitest"
import { toolUseBlock } from "../src/main/adapters/stream-parse"
import { buildFleet, fleetSummary } from "@renderer/lib/fleet"
import type { ChatMessage, SessionMeta } from "@shared/types"

const NOW = 1_750_000_000_000

let seq = 0

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  seq += 1
  return {
    id: `s${seq}`,
    title: `Session ${seq}`,
    project: "alpha",
    provider: "claude",
    cwd: "/tmp/alpha",
    status: "idle",
    createdAt: NOW - 600_000,
    updatedAt: NOW - 60_000,
    ...over,
  }
}

function streamingTurn(sessionId: string, content: string): ChatMessage {
  return {
    id: `m-${sessionId}`,
    sessionId,
    role: "assistant",
    content,
    createdAt: NOW - 5_000,
    streaming: true,
  }
}

function rowIds(sessions: SessionMeta[]) {
  const fleet = buildFleet(sessions, {}, {}, {}, NOW)
  return fleet.groups.flatMap((g) => g.rows.map((r) => r.id))
}

describe("buildFleet", () => {
  it("groups sessions by project", () => {
    const a = session({ project: "alpha" })
    const b = session({ project: "beta" })
    const a2 = session({ project: "alpha" })
    const fleet = buildFleet([a, b, a2], {}, {}, {}, NOW)
    expect(fleet.groups.map((g) => g.project).sort()).toEqual(["alpha", "beta"])
    const alpha = fleet.groups.find((g) => g.project === "alpha")
    expect(alpha?.rows.map((r) => r.id).sort()).toEqual([a.id, a2.id].sort())
  })

  it("orders running before waiting, error, idle, and settled", () => {
    const settled = session({ status: "done", settledAt: NOW - 1_000 })
    const idle = session({ status: "idle" })
    const errored = session({ status: "error" })
    const waiting = session({ status: "waiting_input" })
    const running = session({ status: "running" })
    expect(rowIds([settled, idle, errored, waiting, running])).toEqual([
      running.id,
      waiting.id,
      errored.id,
      idle.id,
      settled.id,
    ])
  })

  it("breaks ties within a rank by recency", () => {
    const older = session({ updatedAt: NOW - 90_000 })
    const newer = session({ updatedAt: NOW - 10_000 })
    expect(rowIds([older, newer])).toEqual([newer.id, older.id])
  })

  it("gives a running row the step of its streaming turn", () => {
    const s = session({ status: "running" })
    const messages = {
      [s.id]: [streamingTurn(s.id, toolUseBlock("Bash", { command: "pnpm test" }, "t1"))],
    }
    const [row] = buildFleet([s], messages, {}, {}, NOW).groups[0].rows
    expect(row.step?.kind).toBe("tool")
    expect(row.step?.label).toBe("Bash")
    expect(row.step?.detail).toBe("pnpm test")
    expect(row.elapsedMs).toBe(5_000)
  })

  it("leaves idle rows without a step even when a stale stream lingers", () => {
    const s = session({ status: "idle" })
    const messages = {
      [s.id]: [streamingTurn(s.id, toolUseBlock("Bash", { command: "ls" }, "t1"))],
    }
    const [row] = buildFleet([s], messages, {}, {}, NOW).groups[0].rows
    expect(row.step).toBeNull()
    expect(row.elapsedMs).toBe(60_000)
  })

  it("excludes archived sessions entirely", () => {
    const kept = session()
    const gone = session({ archived: true })
    const fleet = buildFleet([kept, gone], {}, {}, {}, NOW)
    expect(fleet.total).toBe(1)
    expect(fleet.groups[0].rows.map((r) => r.id)).toEqual([kept.id])
  })

  it("sinks settled rows to the bottom regardless of freshness", () => {
    const settled = session({
      status: "done",
      settledAt: NOW - 500,
      updatedAt: NOW - 1_000,
    })
    const idle = session({ status: "idle", updatedAt: NOW - 300_000 })
    expect(rowIds([settled, idle])).toEqual([idle.id, settled.id])
    const rows = buildFleet([settled, idle], {}, {}, {}, NOW).groups[0].rows
    expect(rows[1].settled).toBe(true)
  })

  it("flags only unsettled waiting and error rows for the pulse", () => {
    const waiting = session({ status: "waiting_input" })
    const failed = session({ status: "error" })
    const settledFail = session({ status: "error", settledAt: NOW - 500 })
    const running = session({ status: "running" })
    const rows = buildFleet(
      [waiting, failed, settledFail, running],
      {},
      {},
      {},
      NOW,
    ).groups[0].rows
    const byId = new Map(rows.map((r) => [r.id, r.attention]))
    expect(byId.get(waiting.id)).toBe(true)
    expect(byId.get(failed.id)).toBe(true)
    expect(byId.get(settledFail.id)).toBe(false)
    expect(byId.get(running.id)).toBe(false)
  })

  it("counts queued follow-ups per row", () => {
    const s = session({ status: "running" })
    const queued = {
      [s.id]: [
        { id: "q1", sessionId: s.id, text: "next", createdAt: NOW },
        { id: "q2", sessionId: s.id, text: "then", createdAt: NOW },
      ],
    }
    const [row] = buildFleet([s], {}, {}, queued, NOW).groups[0].rows
    expect(row.queuedCount).toBe(2)
  })

  it("passes the session cost through untouched", () => {
    const priced = session()
    const free = session()
    const usage = { [priced.id]: { turns: 3, costUsd: 1.234 } }
    const rows = buildFleet([priced, free], {}, usage, {}, NOW).groups[0].rows
    expect(rows.find((r) => r.id === priced.id)?.costUsd).toBe(1.234)
    expect(rows.find((r) => r.id === free.id)?.costUsd).toBeNull()
  })

  it("floats the project with the most urgent row to the top", () => {
    const idleAlpha = session({ project: "alpha", status: "idle" })
    const runningBeta = session({ project: "beta", status: "running" })
    const fleet = buildFleet([idleAlpha, runningBeta], {}, {}, {}, NOW)
    expect(fleet.groups.map((g) => g.project)).toEqual(["beta", "alpha"])
  })
})

describe("fleetSummary", () => {
  it("names only the nonzero buckets", () => {
    expect(
      fleetSummary({ working: 2, waiting: 1, error: 0, idle: 0, settled: 4 }),
    ).toBe("2 working · 1 waiting · 4 settled")
  })

  it("goes quiet when everything is zero", () => {
    expect(
      fleetSummary({ working: 0, waiting: 0, error: 0, idle: 0, settled: 0 }),
    ).toBe("")
  })
})
