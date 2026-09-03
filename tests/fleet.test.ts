import { describe, expect, it } from "vitest"
import { buildFleet, fleetSection, fleetSummary } from "@renderer/lib/fleet"
import type { SessionLiveActivity, SessionMeta } from "@shared/types"

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

function live(over: Partial<SessionLiveActivity> = {}): SessionLiveActivity {
  return {
    phase: "tool",
    stepLabel: "Shell",
    stepDetail: "pnpm test",
    since: NOW - 5_000,
    startedAt: NOW - 20_000,
    ...over,
  }
}

function sectionKinds(sessions: SessionMeta[], seen = {}) {
  return buildFleet(sessions, {}, {}, seen, NOW).sections.map((s) => s.kind)
}

function rowsOf(sessions: SessionMeta[], kind: string, seen = {}) {
  return (
    buildFleet(sessions, {}, {}, seen, NOW).sections.find(
      (s) => s.kind === kind,
    )?.rows ?? []
  )
}

describe("fleetSection", () => {
  it("puts waiting and failed sessions under needs attention", () => {
    expect(fleetSection(session({ status: "waiting_input" }), {})).toBe(
      "attention",
    )
    expect(fleetSection(session({ status: "error" }), {})).toBe("attention")
  })

  it("puts running sessions under working", () => {
    expect(fleetSection(session({ status: "running" }), {})).toBe("working")
  })

  it("puts an unseen done session under to review", () => {
    const s = session({ status: "done", activityAt: NOW - 1_000 })
    expect(fleetSection(s, {})).toBe("review")
  })

  it("moves a seen done session to idle", () => {
    const s = session({ status: "done", activityAt: NOW - 1_000 })
    expect(fleetSection(s, { [s.id]: NOW })).toBe("idle")
  })

  it("keeps settled sessions out of review even when done", () => {
    const s = session({
      status: "done",
      activityAt: NOW - 1_000,
      settledAt: NOW - 500,
    })
    expect(fleetSection(s, {})).toBe("settled")
  })
})

describe("buildFleet", () => {
  it("orders sections attention, working, review, idle, settled", () => {
    const settled = session({ status: "done", settledAt: NOW - 1_000 })
    const idle = session({ status: "idle" })
    const done = session({ status: "done", activityAt: NOW - 1_000 })
    const running = session({ status: "running" })
    const waiting = session({ status: "waiting_input" })
    expect(sectionKinds([settled, idle, done, running, waiting])).toEqual([
      "attention",
      "working",
      "review",
      "idle",
      "settled",
    ])
  })

  it("omits empty sections", () => {
    expect(sectionKinds([session({ status: "running" })])).toEqual(["working"])
  })

  it("ranks waiting before failed inside needs attention, oldest first", () => {
    const failed = session({ status: "error", activityAt: NOW - 1_000 })
    const waitingNew = session({
      status: "waiting_input",
      activityAt: NOW - 2_000,
    })
    const waitingOld = session({
      status: "waiting_input",
      activityAt: NOW - 9_000,
    })
    expect(
      rowsOf([failed, waitingNew, waitingOld], "attention").map((r) => r.id),
    ).toEqual([waitingOld.id, waitingNew.id, failed.id])
  })

  it("gives working rows the meta live step and elapsed from turn start", () => {
    const s = session({ status: "running", live: live() })
    const [row] = rowsOf([s], "working")
    expect(row.live?.phase).toBe("tool")
    expect(row.live?.stepLabel).toBe("Shell")
    expect(row.live?.stepDetail).toBe("pnpm test")
    expect(row.elapsedMs).toBe(20_000)
  })

  it("shows working rows without meta as live-less rather than faking a step", () => {
    const s = session({ status: "running", activityAt: NOW - 40_000 })
    const [row] = rowsOf([s], "working")
    expect(row.live).toBeNull()
    expect(row.elapsedMs).toBe(40_000)
  })

  it("orders working rows longest-running first", () => {
    const young = session({
      status: "running",
      live: live({ startedAt: NOW - 5_000 }),
    })
    const old = session({
      status: "running",
      live: live({ startedAt: NOW - 90_000 }),
    })
    expect(rowsOf([young, old], "working").map((r) => r.id)).toEqual([
      old.id,
      young.id,
    ])
  })

  it("ignores stale meta live on a session that is no longer running", () => {
    const s = session({ status: "idle", live: live() })
    const [row] = rowsOf([s], "idle")
    expect(row.live).toBeNull()
  })

  it("excludes archived sessions entirely", () => {
    const kept = session()
    const gone = session({ archived: true })
    const fleet = buildFleet([kept, gone], {}, {}, {}, NOW)
    expect(fleet.total).toBe(1)
    expect(fleet.sections.flatMap((s) => s.rows.map((r) => r.id))).toEqual([
      kept.id,
    ])
  })

  it("flags only unsettled waiting and error rows for the pulse", () => {
    const waiting = session({ status: "waiting_input" })
    const failed = session({ status: "error" })
    const settledFail = session({ status: "error", settledAt: NOW - 500 })
    const running = session({ status: "running" })
    const fleet = buildFleet(
      [waiting, failed, settledFail, running],
      {},
      {},
      {},
      NOW,
    )
    const byId = new Map(
      fleet.sections.flatMap((s) => s.rows.map((r) => [r.id, r.attention])),
    )
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
    const [row] = buildFleet([s], {}, queued, {}, NOW).sections[0].rows
    expect(row.queuedCount).toBe(2)
  })

  it("passes the session cost through untouched", () => {
    const priced = session()
    const free = session()
    const usage = { [priced.id]: { turns: 3, costUsd: 1.234 } }
    const rows = buildFleet([priced, free], usage, {}, {}, NOW).sections[0].rows
    expect(rows.find((r) => r.id === priced.id)?.costUsd).toBe(1.234)
    expect(rows.find((r) => r.id === free.id)?.costUsd).toBeNull()
  })

  it("tallies section counts", () => {
    const fleet = buildFleet(
      [
        session({ status: "running" }),
        session({ status: "waiting_input" }),
        session({ status: "done", activityAt: NOW - 1_000 }),
        session({ status: "idle" }),
        session({ status: "idle", settledAt: NOW - 500 }),
      ],
      {},
      {},
      {},
      NOW,
    )
    expect(fleet.counts).toEqual({
      attention: 1,
      working: 1,
      review: 1,
      idle: 1,
      settled: 1,
    })
  })
})

describe("fleetSummary", () => {
  it("names only the nonzero buckets", () => {
    expect(
      fleetSummary({ attention: 1, working: 2, review: 3, idle: 0, settled: 4 }),
    ).toBe("1 needs attention · 2 working · 3 to review · 4 settled")
  })

  it("pluralizes needs attention", () => {
    expect(
      fleetSummary({ attention: 2, working: 0, review: 0, idle: 0, settled: 0 }),
    ).toBe("2 need attention")
  })

  it("goes quiet when everything is zero", () => {
    expect(
      fleetSummary({ attention: 0, working: 0, review: 0, idle: 0, settled: 0 }),
    ).toBe("")
  })
})
