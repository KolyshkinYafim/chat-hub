import { describe, expect, it } from "vitest"
import type { HubLayoutCommand, HubPaneSpec } from "@shared/hub-control"
import { applyHubLayout } from "@renderer/lib/hub-layout"
import { MAX_PANES, type PaneLayout } from "@renderer/lib/pane-layout"

function command(
  panes: Array<Partial<HubPaneSpec> & { sessionId: string }>,
  focusSessionId: string | null = null,
): HubLayoutCommand {
  return {
    windowId: 1,
    panes: panes.map((pane) => ({
      sessionId: pane.sessionId,
      dockOpen: pane.dockOpen ?? null,
      surface: pane.surface ?? null,
    })),
    focusSessionId,
    at: 1,
  }
}

const base: PaneLayout = {
  panes: [
    { id: "p1", sessionId: "a", dockOpen: true },
    { id: "p2", sessionId: "b", dockOpen: false },
  ],
  focusedPaneId: "p1",
}

describe("applyHubLayout", () => {
  it("keeps the pane id and dock state of a session that stays", () => {
    const { layout } = applyHubLayout(base, command([{ sessionId: "b" }, { sessionId: "a" }]))
    expect(layout.panes).toEqual([
      { id: "p2", sessionId: "b", dockOpen: false },
      { id: "p1", sessionId: "a", dockOpen: true },
    ])
  })

  it("mints fresh pane ids above the highest existing one", () => {
    const { layout } = applyHubLayout(base, command([{ sessionId: "c" }, { sessionId: "d" }]))
    expect(layout.panes.map((p) => p.id)).toEqual(["p3", "p4"])
  })

  it("focuses the requested session, else the first pane", () => {
    const focused = applyHubLayout(base, command([{ sessionId: "a" }, { sessionId: "b" }], "b"))
    expect(focused.layout.focusedPaneId).toBe("p2")
    const fallback = applyHubLayout(base, command([{ sessionId: "b" }, { sessionId: "a" }], "zz"))
    expect(fallback.layout.focusedPaneId).toBe("p2")
  })

  it("applies an explicit dock choice over the inherited one", () => {
    const { layout } = applyHubLayout(
      base,
      command([{ sessionId: "a", dockOpen: false }]),
    )
    expect(layout.panes).toEqual([{ id: "p1", sessionId: "a", dockOpen: false }])
  })

  it("collects the surface choices per session", () => {
    const { surfaces } = applyHubLayout(
      base,
      command([
        { sessionId: "a", surface: "diff" },
        { sessionId: "b" },
      ]),
    )
    expect(surfaces).toEqual({ a: "diff" })
  })

  it("caps the command at the workspace pane limit", () => {
    const panes = Array.from({ length: MAX_PANES + 2 }, (_, i) => ({
      sessionId: `s-${i}`,
    }))
    const { layout } = applyHubLayout(base, command(panes))
    expect(layout.panes).toHaveLength(MAX_PANES)
  })

  it("leaves the layout alone on an empty command", () => {
    const applied = applyHubLayout(base, command([]))
    expect(applied.layout).toBe(base)
    expect(applied.surfaces).toEqual({})
  })

  it("gives duplicate-session panes their own ids", () => {
    const twice: HubLayoutCommand = {
      windowId: 1,
      panes: [
        { sessionId: "a", dockOpen: null, surface: null },
        { sessionId: "a", dockOpen: null, surface: null },
      ],
      focusSessionId: null,
      at: 1,
    }
    const { layout } = applyHubLayout(base, twice)
    const ids = layout.panes.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
