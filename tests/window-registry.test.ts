import { describe, expect, it } from "vitest"

import {
  nextWindowId,
  pickWindowForSession,
  WindowRegistry,
} from "../src/main/window-registry"

describe("nextWindowId", () => {
  it("starts at 1 so the first window keeps the legacy storage keys", () => {
    expect(nextWindowId([])).toBe(1)
  })

  it("fills the lowest gap a close left behind", () => {
    expect(nextWindowId([1, 3])).toBe(2)
  })

  it("appends when the run is unbroken", () => {
    expect(nextWindowId([1, 2, 3])).toBe(4)
  })

  it("ignores order and duplicates", () => {
    expect(nextWindowId([3, 1, 3])).toBe(2)
  })
})

describe("pickWindowForSession", () => {
  const shows = new Map<number, ReadonlySet<string>>([
    [1, new Set(["a", "b"])],
    [2, new Set(["c"])],
    [3, new Set(["c", "d"])],
  ])

  it("picks the window already showing the session", () => {
    expect(pickWindowForSession("d", shows, [1, 2, 3])).toBe(3)
  })

  it("prefers the most recent of several showing it", () => {
    // Both 2 and 3 hold "c"; the tail of the recency list is in front.
    expect(pickWindowForSession("c", shows, [3, 1, 2])).toBe(2)
    expect(pickWindowForSession("c", shows, [2, 1, 3])).toBe(3)
  })

  it("falls back to the window in front when nobody shows it", () => {
    expect(pickWindowForSession("zzz", shows, [3, 1, 2])).toBe(2)
  })

  it("falls back to the window in front for a surface-only request", () => {
    expect(pickWindowForSession(null, shows, [1, 2])).toBe(2)
  })

  it("reports nothing when no window is open", () => {
    expect(pickWindowForSession("a", shows, [])).toBeNull()
    expect(pickWindowForSession(null, new Map(), [])).toBeNull()
  })

  it("ignores a window that is in the recency list but shows nothing", () => {
    expect(pickWindowForSession("a", shows, [1, 9])).toBe(1)
  })
})

describe("WindowRegistry", () => {
  it("hands out ids that fill the gaps left by closes", () => {
    const reg = new WindowRegistry<string>()
    reg.add(reg.nextId(), "one")
    reg.add(reg.nextId(), "two")
    reg.add(reg.nextId(), "three")
    expect(reg.ids()).toEqual([1, 2, 3])

    reg.remove(2)
    expect(reg.nextId()).toBe(2)
  })

  it("keeps the newest window in front", () => {
    const reg = new WindowRegistry<string>()
    reg.add(1, "one")
    reg.add(2, "two")
    expect(reg.mostRecentId()).toBe(2)
    expect(reg.mostRecent()).toBe("two")
  })

  it("moves a focused window to the front without reordering the rest", () => {
    const reg = new WindowRegistry<string>()
    reg.add(1, "one")
    reg.add(2, "two")
    reg.add(3, "three")
    reg.touch(1)
    expect(reg.recency()).toEqual([2, 3, 1])
    expect(reg.mostRecentId()).toBe(1)
  })

  it("ignores a touch for a window it does not have", () => {
    const reg = new WindowRegistry<string>()
    reg.add(1, "one")
    reg.touch(9)
    expect(reg.recency()).toEqual([1])
    expect(reg.has(9)).toBe(false)
  })

  it("drops a closed window from both the map and the order", () => {
    const reg = new WindowRegistry<string>()
    reg.add(1, "one")
    reg.add(2, "two")
    expect(reg.remove(2)).toBe(true)
    expect(reg.remove(2)).toBe(false)
    expect(reg.recency()).toEqual([1])
    expect(reg.size).toBe(1)
    expect(reg.get(2)).toBeUndefined()
  })

  it("goes empty rather than negative when the last window closes", () => {
    const reg = new WindowRegistry<string>()
    reg.add(1, "one")
    reg.remove(1)
    expect(reg.size).toBe(0)
    expect(reg.mostRecentId()).toBeNull()
    expect(reg.mostRecent()).toBeUndefined()
    // And the next window opened is window 1 again, back on its own panes.
    expect(reg.nextId()).toBe(1)
  })

  it("lists values by id, not by recency", () => {
    const reg = new WindowRegistry<string>()
    reg.add(2, "two")
    reg.add(1, "one")
    expect(reg.values()).toEqual(["one", "two"])
    expect(reg.recency()).toEqual([2, 1])
  })

  it("re-adding an id replaces it and fronts it once", () => {
    const reg = new WindowRegistry<string>()
    reg.add(1, "one")
    reg.add(2, "two")
    reg.add(1, "one-again")
    expect(reg.get(1)).toBe("one-again")
    expect(reg.recency()).toEqual([2, 1])
  })
})
