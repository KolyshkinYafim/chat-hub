import { describe, expect, it } from "vitest"
import { settleQueueFor } from "@renderer/lib/queue-state"

const row = { id: "q1", sessionId: "s1", text: "later", createdAt: 1 }

describe("settleQueueFor", () => {
  it("keeps the rows while the turn is still running or waiting on a form", () => {
    const queued = { s1: [row] }
    expect(settleQueueFor(queued, "s1", "running")).toBe(queued)
    expect(settleQueueFor(queued, "s1", "waiting_input")).toBe(queued)
  })

  it("drops the rows once the session is at rest", () => {
    expect(settleQueueFor({ s1: [row], s2: [row] }, "s1", "idle")).toEqual({ s2: [row] })
    expect(settleQueueFor({ s1: [row] }, "s1", "error")).toEqual({})
    expect(settleQueueFor({ s1: [row] }, "s1", "done")).toEqual({})
  })

  it("returns the same object when there was nothing to drop", () => {
    const queued = { s2: [row] }
    expect(settleQueueFor(queued, "s1", "idle")).toBe(queued)
    expect(settleQueueFor({ s1: [] }, "s1", "idle")).toEqual({ s1: [] })
  })
})
