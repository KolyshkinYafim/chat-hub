import { describe, expect, it } from "vitest"
import { LiveActivityTracker } from "../src/main/live-activity"
import type { AgentTurnItem, TurnItemStatus } from "@shared/types"

const T0 = 1_750_000_000_000

function command(
  id: string,
  status: TurnItemStatus,
  cmd = "pnpm test",
): AgentTurnItem {
  return { id, kind: "command", status, command: cmd }
}

function reasoning(id: string, status: TurnItemStatus): AgentTurnItem {
  return { id, kind: "reasoning", status, summary: "…" }
}

describe("LiveActivityTracker", () => {
  it("begins a turn in connecting with the turn start stamped", () => {
    const tracker = new LiveActivityTracker()
    const activity = tracker.begin("s1", T0)
    expect(activity).toEqual({
      phase: "connecting",
      stepLabel: "Connecting",
      since: T0,
      startedAt: T0,
    })
    expect(tracker.get("s1")).toEqual(activity)
  })

  it("moves to writing on the first delta and stays silent on the next ones", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    const first = tracker.delta("s1", T0 + 100)
    expect(first?.phase).toBe("thinking")
    expect(first?.stepLabel).toBe("Writing")
    expect(first?.since).toBe(T0 + 100)
    expect(first?.startedAt).toBe(T0)
    expect(tracker.delta("s1", T0 + 200)).toBeNull()
    expect(tracker.delta("s1", T0 + 300)).toBeNull()
    expect(tracker.get("s1")?.since).toBe(T0 + 100)
  })

  it("reports a running tool with its label and detail", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    const activity = tracker.item("s1", command("c1", "running"), T0 + 500)
    expect(activity?.phase).toBe("tool")
    expect(activity?.stepLabel).toBe("Shell")
    expect(activity?.stepDetail).toBe("pnpm test")
  })

  it("stays silent on a repeated update of the same step", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    tracker.item("s1", command("c1", "running"), T0 + 500)
    expect(tracker.item("s1", command("c1", "running"), T0 + 700)).toBeNull()
    expect(tracker.get("s1")?.since).toBe(T0 + 500)
  })

  it("ignores deltas while a tool is open", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    tracker.item("s1", command("c1", "running"), T0 + 500)
    expect(tracker.delta("s1", T0 + 600)).toBeNull()
    expect(tracker.get("s1")?.phase).toBe("tool")
  })

  it("falls back to thinking when the last open tool completes", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    tracker.item("s1", command("c1", "running"), T0 + 500)
    const done = tracker.item("s1", command("c1", "completed"), T0 + 900)
    expect(done?.phase).toBe("thinking")
    expect(done?.stepLabel).toBe("Thinking")
  })

  it("keeps the newer running tool when two overlap", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    tracker.item("s1", command("c1", "running", "ls"), T0 + 100)
    const second = tracker.item(
      "s1",
      command("c2", "running", "pnpm lint"),
      T0 + 200,
    )
    expect(second?.stepDetail).toBe("pnpm lint")
    const back = tracker.item("s1", command("c2", "completed", "pnpm lint"), T0 + 300)
    expect(back?.phase).toBe("tool")
    expect(back?.stepDetail).toBe("ls")
  })

  it("treats an open reasoning item as thinking, not a tool", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    const activity = tracker.item("s1", reasoning("r1", "running"), T0 + 100)
    expect(activity?.phase).toBe("thinking")
    expect(activity?.stepLabel).toBe("Thinking")
  })

  it("resets state when a new turn begins", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    tracker.item("s1", command("c1", "running"), T0 + 100)
    const fresh = tracker.begin("s1", T0 + 10_000)
    expect(fresh.phase).toBe("connecting")
    expect(fresh.startedAt).toBe(T0 + 10_000)
    const thinking = tracker.item("s1", reasoning("r1", "running"), T0 + 10_100)
    expect(thinking?.phase).toBe("thinking")
  })

  it("goes quiet for sessions it is not tracking", () => {
    const tracker = new LiveActivityTracker()
    expect(tracker.delta("ghost", T0)).toBeNull()
    expect(tracker.item("ghost", command("c1", "running"), T0)).toBeNull()
    expect(tracker.get("ghost")).toBeUndefined()
  })

  it("clears a session and reports whether it was live", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    expect(tracker.clear("s1")).toBe(true)
    expect(tracker.clear("s1")).toBe(false)
    expect(tracker.get("s1")).toBeUndefined()
    expect(tracker.delta("s1", T0 + 100)).toBeNull()
  })

  it("clamps a long tool detail to one line", () => {
    const tracker = new LiveActivityTracker()
    tracker.begin("s1", T0)
    const activity = tracker.item(
      "s1",
      command("c1", "running", `echo ${"x".repeat(200)}`),
      T0 + 100,
    )
    expect(activity?.stepDetail?.length).toBeLessThanOrEqual(80)
  })
})
