import { describe, expect, it } from "vitest"
import {
  commitTarget,
  filterByQuery,
  initialCursor,
  mruOrder,
  shouldOpenSwitcher,
} from "@renderer/lib/session-switcher"
import { touchRecent } from "@renderer/lib/transcript-cache"

type Entry = {
  id: string
  title: string
  project: string
  provider: string
  updatedAt: number
}

function entry(id: string, title: string, updatedAt: number): Entry {
  return { id, title, project: `${id}-proj`, provider: "claude", updatedAt }
}

describe("mruOrder over the transcript LRU", () => {
  it("orders sessions by touchRecent visit history", () => {
    const sessions = [
      entry("a", "Alpha", 100),
      entry("b", "Beta", 200),
      entry("c", "Gamma", 300),
    ]
    let recent: readonly string[] = []
    for (const id of ["a", "c", "b", "c"]) recent = touchRecent(recent, id)
    expect(mruOrder(sessions, recent).map((s) => s.id)).toEqual([
      "c",
      "b",
      "a",
    ])
  })

  it("keeps sessions evicted past the LRU cap listed by activity", () => {
    const sessions = [
      entry("a", "Alpha", 100),
      entry("b", "Beta", 200),
      entry("c", "Gamma", 300),
    ]
    let recent: readonly string[] = []
    for (const id of ["c", "a", "b"]) recent = touchRecent(recent, id, 2)
    expect(mruOrder(sessions, recent).map((s) => s.id)).toEqual([
      "b",
      "a",
      "c",
    ])
  })
})

describe("mruOrder", () => {
  const sessions = [
    entry("a", "Alpha", 100),
    entry("b", "Beta", 300),
    entry("c", "Gamma", 200),
    entry("d", "Delta", 400),
  ]

  it("orders by most-recently-used first", () => {
    const ordered = mruOrder(sessions, ["c", "a", "d", "b"])
    expect(ordered.map((s) => s.id)).toEqual(["c", "a", "d", "b"])
  })

  it("appends sessions never visited, newest activity first", () => {
    const ordered = mruOrder(sessions, ["a"])
    expect(ordered.map((s) => s.id)).toEqual(["a", "d", "b", "c"])
  })

  it("ignores recent ids that no longer exist", () => {
    const ordered = mruOrder(sessions, ["ghost", "b"])
    expect(ordered.map((s) => s.id)).toEqual(["b", "d", "c", "a"])
  })

  it("falls back to activity order with no history at all", () => {
    const ordered = mruOrder(sessions, [])
    expect(ordered.map((s) => s.id)).toEqual(["d", "b", "c", "a"])
  })

  it("does not mutate its input", () => {
    const before = sessions.map((s) => s.id)
    mruOrder(sessions, ["c"])
    expect(sessions.map((s) => s.id)).toEqual(before)
  })
})

describe("initialCursor", () => {
  it("preselects the second-most-recent session", () => {
    expect(initialCursor(4)).toBe(1)
  })

  it("falls back to the only row when there is just one", () => {
    expect(initialCursor(1)).toBe(0)
    expect(initialCursor(0)).toBe(0)
  })
})

describe("shouldOpenSwitcher", () => {
  it("needs at least two sessions to be worth opening", () => {
    expect(shouldOpenSwitcher(0)).toBe(false)
    expect(shouldOpenSwitcher(1)).toBe(false)
    expect(shouldOpenSwitcher(2)).toBe(true)
  })
})

describe("filterByQuery", () => {
  const sessions = [
    entry("a", "Refactor auth middleware", 100),
    entry("b", "Fix webhook retries", 200),
    entry("c", "Auth token rotation", 300),
  ]

  it("keeps the given order while the query is empty", () => {
    expect(filterByQuery(sessions, "").map((s) => s.id)).toEqual([
      "a",
      "b",
      "c",
    ])
    expect(filterByQuery(sessions, "  ").map((s) => s.id)).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("narrows to fuzzy matches only", () => {
    const hits = filterByQuery(sessions, "webhook")
    expect(hits.map((s) => s.id)).toEqual(["b"])
  })

  it("ranks the tighter match first", () => {
    const hits = filterByQuery(sessions, "auth")
    expect(hits.map((s) => s.id)).toEqual(["c", "a"])
  })

  it("returns nothing when nothing matches", () => {
    expect(filterByQuery(sessions, "zzz")).toEqual([])
  })
})

describe("commitTarget", () => {
  const sessions = [
    entry("a", "Alpha", 100),
    entry("b", "Beta", 200),
    entry("c", "Gamma", 300),
  ]

  it("resolves the row under the cursor", () => {
    expect(commitTarget(sessions, 1)?.id).toBe("b")
  })

  it("clamps a cursor beyond a list narrowed by filtering", () => {
    expect(commitTarget(sessions.slice(0, 1), 2)?.id).toBe("a")
  })

  it("resolves nothing from an empty list", () => {
    expect(commitTarget([], 0)).toBeNull()
  })
})
