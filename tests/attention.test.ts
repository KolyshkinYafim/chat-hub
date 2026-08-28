import { describe, expect, it } from "vitest"

import type { SessionMeta } from "../src/shared/types"
import { attentionBadge, needsAction } from "../src/shared/attention"
import {
  attentionQueue,
  dampOrder,
  isUnseenDone,
  markSeen,
  nextAttention,
  parseAttentionSeen,
  pruneSeen,
  RESORT_INTERVAL_MS,
  type DampedOrder,
} from "../src/renderer/src/lib/attention"

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    title: "Fix the flaky test",
    project: "hub",
    provider: "claude",
    cwd: "/Users/dev/hub",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }
}

describe("needsAction", () => {
  it("holds for waiting_input and error", () => {
    expect(needsAction(session({ status: "waiting_input" }))).toBe(true)
    expect(needsAction(session({ status: "error" }))).toBe(true)
  })

  it("ignores running, idle and done", () => {
    expect(needsAction(session({ status: "running" }))).toBe(false)
    expect(needsAction(session({ status: "idle" }))).toBe(false)
    expect(needsAction(session({ status: "done" }))).toBe(false)
  })

  it("treats settling and archiving as handled", () => {
    expect(
      needsAction(session({ status: "waiting_input", settledAt: 9 })),
    ).toBe(false)
    expect(needsAction(session({ status: "error", archived: true }))).toBe(
      false,
    )
  })
})

describe("attentionBadge", () => {
  it("prints a positive count and hides zero", () => {
    expect(attentionBadge(2)).toBe("2")
    expect(attentionBadge(1)).toBe("1")
    expect(attentionBadge(0)).toBe("")
  })
})

describe("seen semantics for done sessions", () => {
  it("a fresh done session is unseen", () => {
    expect(isUnseenDone(session({ status: "done", updatedAt: 10 }), {})).toBe(
      true,
    )
  })

  it("marking seen at its current updatedAt clears it", () => {
    const s = session({ status: "done", updatedAt: 10 })
    const seen = markSeen({}, s.id, s.updatedAt)
    expect(isUnseenDone(s, seen)).toBe(false)
  })

  it("a later done makes it unseen again", () => {
    const seen = markSeen({}, "s1", 10)
    expect(isUnseenDone(session({ status: "done", updatedAt: 20 }), seen)).toBe(
      true,
    )
  })

  it("marking seen never moves a mark backwards", () => {
    const seen = markSeen(markSeen({}, "s1", 20), "s1", 10)
    expect(seen).toEqual({ s1: 20 })
  })

  it("compares against activityAt, so a metadata bump cannot resurrect it", () => {
    const s = session({ status: "done", activityAt: 10, updatedAt: 40 })
    expect(isUnseenDone(s, markSeen({}, s.id, 10))).toBe(false)
  })

  it("falls back to updatedAt for sessions that predate the stamp", () => {
    expect(isUnseenDone(session({ status: "done", updatedAt: 10 }), {})).toBe(
      true,
    )
    expect(
      isUnseenDone(
        session({ status: "done", updatedAt: 10 }),
        markSeen({}, "s1", 10),
      ),
    ).toBe(false)
  })

  it("settled or archived done sessions are not unseen", () => {
    expect(
      isUnseenDone(session({ status: "done", settledAt: 5 }), {}),
    ).toBe(false)
    expect(
      isUnseenDone(session({ status: "done", archived: true }), {}),
    ).toBe(false)
  })

  it("pruneSeen drops marks for dead sessions and keeps identity otherwise", () => {
    const seen = { a: 1, b: 2 }
    expect(pruneSeen(seen, new Set(["a"]))).toEqual({ a: 1 })
    expect(pruneSeen(seen, new Set(["a", "b"]))).toBe(seen)
  })
})

describe("parseAttentionSeen", () => {
  it("reads a stored map of finite stamps", () => {
    expect(parseAttentionSeen('{"a":10,"b":20}')).toEqual({ a: 10, b: 20 })
  })

  it("treats an absent value as an empty store", () => {
    expect(parseAttentionSeen(null)).toEqual({})
  })

  it("drops entries that are not finite numbers", () => {
    expect(
      parseAttentionSeen('{"a":1,"b":"x","c":null,"d":1e999}'),
    ).toEqual({ a: 1 })
  })

  it("survives corrupt or non-object payloads", () => {
    expect(parseAttentionSeen("{not json")).toEqual({})
    expect(parseAttentionSeen("[1,2]")).toEqual({})
    expect(parseAttentionSeen('"seen"')).toEqual({})
    expect(parseAttentionSeen("null")).toEqual({})
  })
})

describe("attentionQueue", () => {
  const waitingOld = session({ id: "w-old", status: "waiting_input", updatedAt: 10 })
  const waitingNew = session({ id: "w-new", status: "waiting_input", updatedAt: 50 })
  const errored = session({ id: "err", status: "error", updatedAt: 5 })
  const doneUnseen = session({ id: "done", status: "done", updatedAt: 30 })
  const running = session({ id: "run", status: "running", updatedAt: 1 })
  const idle = session({ id: "idle", status: "idle", updatedAt: 1 })

  it("orders waiting, then error, then unseen done", () => {
    const queue = attentionQueue(
      [running, doneUnseen, errored, waitingNew, idle, waitingOld],
      {},
    )
    expect(queue.map((s) => s.id)).toEqual(["w-old", "w-new", "err", "done"])
  })

  it("sorts a class by how long it has waited, oldest first", () => {
    const queue = attentionQueue([waitingNew, waitingOld], {})
    expect(queue.map((s) => s.id)).toEqual(["w-old", "w-new"])
  })

  it("orders by activityAt, unmoved by later metadata-only updatedAt bumps", () => {
    const renamed = session({
      id: "renamed",
      status: "waiting_input",
      activityAt: 5,
      updatedAt: 90,
    })
    const untouched = session({
      id: "untouched",
      status: "waiting_input",
      activityAt: 20,
      updatedAt: 20,
    })
    const queue = attentionQueue([untouched, renamed], {})
    expect(queue.map((s) => s.id)).toEqual(["renamed", "untouched"])
  })

  it("breaks exact ties deterministically by id", () => {
    const a = session({ id: "b", status: "error", updatedAt: 7 })
    const b = session({ id: "a", status: "error", updatedAt: 7 })
    expect(attentionQueue([a, b], {}).map((s) => s.id)).toEqual(["a", "b"])
  })

  it("drops a done session once seen, but keeps waiting and error regardless", () => {
    const seen = {
      done: doneUnseen.updatedAt,
      "w-old": waitingOld.updatedAt,
      err: errored.updatedAt,
    }
    const queue = attentionQueue([doneUnseen, waitingOld, errored], seen)
    expect(queue.map((s) => s.id)).toEqual(["w-old", "err"])
  })

  it("excludes archived and settled sessions", () => {
    const queue = attentionQueue(
      [
        session({ id: "a", status: "waiting_input", archived: true }),
        session({ id: "b", status: "error", settledAt: 9 }),
      ],
      {},
    )
    expect(queue).toEqual([])
  })
})

describe("nextAttention", () => {
  const queue = [
    session({ id: "a", status: "waiting_input", updatedAt: 1 }),
    session({ id: "b", status: "error", updatedAt: 2 }),
    session({ id: "c", status: "done", updatedAt: 3 }),
  ]

  it("starts at the head when the current session is not queued", () => {
    expect(nextAttention(queue, null)?.id).toBe("a")
    expect(nextAttention(queue, "elsewhere")?.id).toBe("a")
  })

  it("steps through the queue and wraps around", () => {
    expect(nextAttention(queue, "a")?.id).toBe("b")
    expect(nextAttention(queue, "b")?.id).toBe("c")
    expect(nextAttention(queue, "c")?.id).toBe("a")
  })

  it("returns null on an empty queue", () => {
    expect(nextAttention([], "a")).toBeNull()
  })
})

describe("dampOrder", () => {
  const seed = (ids: string[], now = 0): DampedOrder =>
    dampOrder(null, ids, now)

  it("adopts the first order without spending the resort budget", () => {
    const first = seed(["a", "b"], 1000)
    expect(first.order).toEqual(["a", "b"])
    expect(first.resortedAt).toBeNull()
    const churned = dampOrder(first, ["b", "a"], 2000)
    expect(churned.order).toEqual(["b", "a"])
    expect(churned.resortedAt).toBe(2000)
  })

  it("keeps identity when nothing changed", () => {
    const first = seed(["a", "b"])
    expect(dampOrder(first, ["a", "b"], 5000)).toBe(first)
  })

  it("adds new members immediately, at their sorted position", () => {
    const first = seed(["a", "c"])
    const withNew = dampOrder(first, ["a", "b", "c"], 1000)
    expect(withNew.order).toEqual(["a", "b", "c"])
    expect(withNew.resortedAt).toBeNull()
  })

  it("removes departed members immediately", () => {
    const first = seed(["a", "b", "c"])
    const shrunk = dampOrder(first, ["a", "c"], 1000)
    expect(shrunk.order).toEqual(["a", "c"])
    expect(shrunk.resortedAt).toBeNull()
  })

  it("holds a reorder while the budget is spent", () => {
    const resorted = dampOrder(seed(["a", "b"]), ["b", "a"], 10_000)
    expect(resorted.order).toEqual(["b", "a"])
    const held = dampOrder(resorted, ["a", "b"], 10_000 + RESORT_INTERVAL_MS - 1)
    expect(held.order).toEqual(["b", "a"])
    expect(held.resortedAt).toBe(10_000)
  })

  it("applies the reorder once the interval has passed", () => {
    const resorted = dampOrder(seed(["a", "b"]), ["b", "a"], 10_000)
    const later = dampOrder(resorted, ["a", "b"], 10_000 + RESORT_INTERVAL_MS)
    expect(later.order).toEqual(["a", "b"])
    expect(later.resortedAt).toBe(10_000 + RESORT_INTERVAL_MS)
  })

  it("re-sorts at most once per interval under continuous churn", () => {
    let state = seed(["a", "b", "c"])
    const reshuffles: number[] = []
    let previous = state.order
    for (let tick = 0; tick < 10 * 60; tick++) {
      const now = 1000 * tick
      const spin = tick % 3
      const desired =
        spin === 0
          ? ["a", "b", "c"]
          : spin === 1
            ? ["c", "a", "b"]
            : ["b", "c", "a"]
      state = dampOrder(state, desired, now)
      if (state.order.join() !== previous.join()) reshuffles.push(now)
      previous = state.order
    }
    expect(reshuffles.length).toBeGreaterThan(0)
    for (let i = 1; i < reshuffles.length; i++) {
      expect(reshuffles[i] - reshuffles[i - 1]).toBeGreaterThanOrEqual(
        RESORT_INTERVAL_MS,
      )
    }
  })

  it("inserts a newcomer without reshuffling the members it joins", () => {
    const committed = dampOrder(seed(["a", "b"]), ["b", "a"], 1000)
    expect(committed.order).toEqual(["b", "a"])
    const withNew = dampOrder(committed, ["a", "n", "b"], 2000)
    expect(withNew.order.filter((id) => id !== "n")).toEqual(["b", "a"])
    expect(withNew.order).toContain("n")
    expect(withNew.resortedAt).toBe(1000)
  })
})
