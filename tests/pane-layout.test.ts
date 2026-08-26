import { describe, expect, it } from "vitest"

import {
  assignSession,
  browserOwnerPane,
  closePane,
  comfortablePaneCount,
  focusedPane,
  focusPane,
  isNoopMove,
  MAX_PANES,
  MIN_PANE_WIDTH,
  movePane,
  nextPaneId,
  openPaneAt,
  paneForSession,
  paneWidth,
  parseLayout,
  pruneLayout,
  resolveDrop,
  serializeLayout,
  setPaneDock,
  soloLayout,
  stepFocus,
  type PaneLayout,
  type PaneRect,
} from "@renderer/lib/pane-layout"

function layout(ids: (string | null)[]): PaneLayout {
  return {
    panes: ids.map((sessionId, i) => ({
      id: `p${i + 1}`,
      sessionId,
      dockOpen: false,
    })),
    focusedPaneId: "p1",
  }
}

const sessionsOf = (l: PaneLayout): (string | null)[] =>
  l.panes.map((p) => p.sessionId)

const idsOf = (l: PaneLayout): string[] => l.panes.map((p) => p.id)

describe("solo layout", () => {
  it("is one pane carrying the dock preference", () => {
    const solo = soloLayout("s1", true)
    expect(solo.panes).toEqual([{ id: "p1", sessionId: "s1", dockOpen: true }])
    expect(solo.focusedPaneId).toBe("p1")
  })

  it("names the next pane after the highest one in use", () => {
    expect(nextPaneId(soloLayout(null, false))).toBe("p2")
    expect(nextPaneId(layout(["a", "b", "c"]))).toBe("p4")
  })
})

describe("focus", () => {
  it("falls back to the first pane when the focused id is gone", () => {
    const broken = { ...layout(["a", "b"]), focusedPaneId: "nope" }
    expect(focusedPane(broken).id).toBe("p1")
  })

  it("ignores a pane that is not on screen", () => {
    const l = layout(["a", "b"])
    expect(focusPane(l, "p9")).toBe(l)
  })

  it("wraps at both ends so the binding never dead-ends", () => {
    const l = layout(["a", "b", "c"])
    expect(stepFocus(l, 1).focusedPaneId).toBe("p2")
    expect(stepFocus(l, -1).focusedPaneId).toBe("p3")
    expect(stepFocus(focusPane(l, "p3"), 1).focusedPaneId).toBe("p1")
  })

  it("does nothing with a single pane", () => {
    const solo = soloLayout("s1", false)
    expect(stepFocus(solo, 1)).toBe(solo)
  })
})

describe("binding a session to a pane", () => {
  it("shows the chat and focuses the pane it landed in", () => {
    const next = assignSession(layout(["a", "b"]), "p2", "c")
    expect(sessionsOf(next)).toEqual(["a", "c"])
    expect(next.focusedPaneId).toBe("p2")
  })

  it("swaps rather than running one transcript in two panes", () => {
    const next = assignSession(layout(["a", "b", "c"]), "p1", "c")
    expect(sessionsOf(next)).toEqual(["c", "b", "a"])
  })

  it("swaps an empty pane in too", () => {
    const next = assignSession(layout([null, "b"]), "p1", "b")
    expect(sessionsOf(next)).toEqual(["b", null])
  })

  it("re-dropping the chat a pane already holds only moves focus", () => {
    const next = assignSession(layout(["a", "b"]), "p2", "b")
    expect(sessionsOf(next)).toEqual(["a", "b"])
    expect(next.focusedPaneId).toBe("p2")
  })

  it("leaves an unknown pane alone", () => {
    const l = layout(["a"])
    expect(assignSession(l, "p9", "b")).toBe(l)
  })
})

describe("opening a pane on a seam", () => {
  it("inserts at the seam and focuses the new pane", () => {
    const next = openPaneAt(layout(["a", "b"]), "c", 1, "p3")
    expect(sessionsOf(next)).toEqual(["a", "c", "b"])
    expect(next.focusedPaneId).toBe("p3")
  })

  it("appends past the last pane", () => {
    expect(sessionsOf(openPaneAt(layout(["a"]), "b", 1, "p2"))).toEqual([
      "a",
      "b",
    ])
  })

  it("opens an empty pane for a chat that does not exist yet", () => {
    const next = openPaneAt(layout(["a"]), null, 0, "p2")
    expect(sessionsOf(next)).toEqual([null, "a"])
    expect(next.focusedPaneId).toBe("p2")
  })

  it("moves a chat that is already on screen instead of opening it twice", () => {
    const next = openPaneAt(layout(["a", "b", "c"]), "c", 0, "p4")
    expect(sessionsOf(next)).toEqual(["c", "a", "b"])
    expect(idsOf(next)).toEqual(["p3", "p1", "p2"])
  })

  it("hands the chat to the pane beside the seam once the strip is full", () => {
    const full = layout(Array.from({ length: MAX_PANES }, (_, i) => `s${i}`))
    const next = openPaneAt(full, "new", MAX_PANES, `p${MAX_PANES + 1}`)
    expect(next.panes).toHaveLength(MAX_PANES)
    expect(sessionsOf(next)[MAX_PANES - 1]).toBe("new")
  })
})

describe("reordering", () => {
  it("drops a pane on a seam to its right without losing a slot", () => {
    const next = movePane(layout(["a", "b", "c"]), "p1", 2)
    expect(sessionsOf(next)).toEqual(["b", "a", "c"])
  })

  it("drops a pane on a seam to its left", () => {
    const next = movePane(layout(["a", "b", "c"]), "p3", 0)
    expect(sessionsOf(next)).toEqual(["c", "a", "b"])
  })

  it("keeps the dragged pane focused", () => {
    expect(movePane(layout(["a", "b"]), "p2", 0).focusedPaneId).toBe("p2")
  })

  it("recognises the two seams that mean 'stay put'", () => {
    const l = layout(["a", "b", "c"])
    expect(isNoopMove(l, "p2", 1)).toBe(true)
    expect(isNoopMove(l, "p2", 2)).toBe(true)
    expect(isNoopMove(l, "p2", 0)).toBe(false)
    expect(isNoopMove(l, "p2", 3)).toBe(false)
  })
})

describe("closing a pane", () => {
  it("removes the column and keeps the sessions", () => {
    const next = closePane(layout(["a", "b", "c"]), "p2")
    expect(sessionsOf(next)).toEqual(["a", "c"])
  })

  it("hands focus to the pane that takes its place", () => {
    const l = focusPane(layout(["a", "b", "c"]), "p2")
    expect(closePane(l, "p2").focusedPaneId).toBe("p3")
  })

  it("hands focus left when the last pane closes", () => {
    const l = focusPane(layout(["a", "b"]), "p2")
    expect(closePane(l, "p2").focusedPaneId).toBe("p1")
  })

  it("never closes the last pane", () => {
    const solo = soloLayout("a", false)
    expect(closePane(solo, "p1")).toBe(solo)
  })
})

describe("the dock belongs to the pane", () => {
  it("opens one pane's dock and leaves the rest alone", () => {
    const next = setPaneDock(layout(["a", "b"]), "p2", true)
    expect(next.panes.map((p) => p.dockOpen)).toEqual([false, true])
  })

  it("is a no-op when nothing changes", () => {
    const l = layout(["a"])
    expect(setPaneDock(l, "p1", false)).toBe(l)
    expect(setPaneDock(l, "p9", true)).toBe(l)
  })
})

describe("pruning deleted sessions", () => {
  const live = new Set(["a", "c"])

  it("closes panes whose chat is gone", () => {
    const next = pruneLayout(layout(["a", "b", "c"]), live)
    expect(sessionsOf(next)).toEqual(["a", "c"])
  })

  it("keeps a pane that is deliberately empty", () => {
    const next = pruneLayout(layout([null, "b"]), live)
    expect(sessionsOf(next)).toEqual([null])
  })

  it("leaves a healthy layout untouched by identity", () => {
    const l = layout(["a", "c"])
    expect(pruneLayout(l, live)).toBe(l)
  })

  it("empties the last pane rather than leaving none", () => {
    const next = pruneLayout(layout(["b"]), live)
    expect(next.panes).toHaveLength(1)
    expect(next.panes[0]?.sessionId).toBeNull()
  })

  it("re-homes focus when the focused pane closes", () => {
    const l = focusPane(layout(["a", "b"]), "p2")
    expect(pruneLayout(l, live).focusedPaneId).toBe("p1")
  })

  it("finds the pane a session lives in", () => {
    expect(paneForSession(layout(["a", "b"]), "b")?.id).toBe("p2")
    expect(paneForSession(layout(["a"]), "zz")).toBeNull()
  })
})

describe("resolving a drop", () => {
  const rects: PaneRect[] = [
    { id: "p1", left: 0, right: 300 },
    { id: "p2", left: 300, right: 600 },
  ]

  it("drops into the middle of a pane", () => {
    expect(resolveDrop(150, rects)).toEqual({ kind: "into", paneId: "p1" })
    expect(resolveDrop(450, rects)).toEqual({ kind: "into", paneId: "p2" })
  })

  it("reads the leading edge as a new pane before it", () => {
    expect(resolveDrop(10, rects)).toEqual({ kind: "insert", index: 0 })
    expect(resolveDrop(310, rects)).toEqual({ kind: "insert", index: 1 })
  })

  it("reads the trailing edge as a new pane after it", () => {
    expect(resolveDrop(295, rects)).toEqual({ kind: "insert", index: 1 })
    expect(resolveDrop(595, rects)).toEqual({ kind: "insert", index: 2 })
  })

  it("keeps the band inside a narrow pane", () => {
    const narrow: PaneRect[] = [{ id: "p1", left: 0, right: 90 }]
    expect(resolveDrop(45, narrow)).toEqual({ kind: "into", paneId: "p1" })
    expect(resolveDrop(5, narrow)).toEqual({ kind: "insert", index: 0 })
  })

  it("lands past the strip and before it", () => {
    expect(resolveDrop(900, rects)).toEqual({ kind: "insert", index: 2 })
    expect(resolveDrop(-40, rects)).toEqual({ kind: "insert", index: 0 })
  })

  it("finds the seam in a gap between panes", () => {
    const gapped: PaneRect[] = [
      { id: "p1", left: 0, right: 300 },
      { id: "p2", left: 320, right: 620 },
    ]
    expect(resolveDrop(310, gapped)).toEqual({ kind: "insert", index: 1 })
  })

  it("offers only seams while a pane itself is being dragged", () => {
    expect(resolveDrop(100, rects, { allowInto: false })).toEqual({
      kind: "insert",
      index: 0,
    })
    expect(resolveDrop(200, rects, { allowInto: false })).toEqual({
      kind: "insert",
      index: 1,
    })
  })

  it("has nothing to say with no panes measured", () => {
    expect(resolveDrop(10, [])).toBeNull()
  })
})

describe("how many fit", () => {
  it("counts whole panes at the readable floor", () => {
    // 1280px window less the 268px sidebar.
    expect(comfortablePaneCount(1012)).toBe(2)
    // Same window with the sidebar collapsed to its 84px rail.
    expect(comfortablePaneCount(1196)).toBe(3)
    expect(comfortablePaneCount(200)).toBe(1)
  })

  it("divides the strip until the floor, then stops", () => {
    expect(paneWidth(1012, 2)).toBe(506)
    expect(paneWidth(1012, 3)).toBe(MIN_PANE_WIDTH)
    expect(paneWidth(1012, 0)).toBe(0)
  })
})

describe("who owns the browser guest", () => {
  const claims = [
    { id: "p1", wantsBrowser: true },
    { id: "p2", wantsBrowser: true },
  ]

  it("keeps the pane that claimed it", () => {
    expect(browserOwnerPane(claims, "p2")).toBe("p2")
  })

  it("falls to the leftmost claimant when the owner drops it", () => {
    expect(browserOwnerPane(claims, null)).toBe("p1")
    expect(browserOwnerPane(claims, "p9")).toBe("p1")
  })

  it("re-homes when the owner switches surface", () => {
    const moved = [
      { id: "p1", wantsBrowser: false },
      { id: "p2", wantsBrowser: true },
    ]
    expect(browserOwnerPane(moved, "p1")).toBe("p2")
  })

  it("has no owner when nobody wants it", () => {
    expect(browserOwnerPane([{ id: "p1", wantsBrowser: false }], "p1")).toBeNull()
  })
})

describe("what survives a restart", () => {
  it("round-trips", () => {
    const l = setPaneDock(focusPane(layout(["a", "b"]), "p2"), "p2", true)
    expect(parseLayout(serializeLayout(l))).toEqual(l)
  })

  it("reads nothing from junk, an old version or an empty strip", () => {
    expect(parseLayout(null)).toBeNull()
    expect(parseLayout("{not json")).toBeNull()
    expect(parseLayout('{"v":99,"panes":[],"focusedPaneId":"p1"}')).toBeNull()
    expect(parseLayout('{"v":1,"panes":[],"focusedPaneId":"p1"}')).toBeNull()
    expect(parseLayout('["p1"]')).toBeNull()
  })

  it("drops malformed and duplicated rows", () => {
    const parsed = parseLayout(
      '{"v":1,"panes":[{"id":"p1","sessionId":"a"},7,{"id":"p1","sessionId":"b"},{"id":"p2","sessionId":null,"dockOpen":true}],"focusedPaneId":"p2"}',
    )
    expect(parsed?.panes).toEqual([
      { id: "p1", sessionId: "a", dockOpen: false },
      { id: "p2", sessionId: null, dockOpen: true },
    ])
    expect(parsed?.focusedPaneId).toBe("p2")
  })

  it("re-homes a focus that names a pane the file does not have", () => {
    const parsed = parseLayout(
      '{"v":1,"panes":[{"id":"p4","sessionId":"a"}],"focusedPaneId":"gone"}',
    )
    expect(parsed?.focusedPaneId).toBe("p4")
  })

  it("refuses to restore more panes than the strip allows", () => {
    const many = {
      v: 1,
      panes: Array.from({ length: MAX_PANES + 3 }, (_, i) => ({
        id: `p${i + 1}`,
        sessionId: `s${i}`,
        dockOpen: false,
      })),
      focusedPaneId: "p1",
    }
    expect(parseLayout(JSON.stringify(many))?.panes).toHaveLength(MAX_PANES)
  })
})
