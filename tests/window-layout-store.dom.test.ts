import { beforeEach, describe, expect, it } from "vitest"

import {
  hasStoredLayout,
  layoutKey,
  loadLayout,
  saveLayout,
  soloLayout,
  type PaneLayout,
} from "../src/renderer/src/lib/pane-layout"
import {
  loadDockOpen,
  saveDockOpen,
} from "../src/renderer/src/lib/surface-store"

const LEGACY_KEY = "chat-hub.workspace.panes"

function layout(sessionId: string): PaneLayout {
  return soloLayout(sessionId, false)
}

beforeEach(() => {
  localStorage.clear()
})

describe("per-window pane layout storage", () => {
  it("keeps window 1 on the key the app already wrote", () => {
    expect(layoutKey(1)).toBe(LEGACY_KEY)
    saveLayout(layout("s1"), 1)
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull()
  })

  it("reads a layout written before multiwindow existed", () => {
    saveLayout(layout("old"), 1)
    const raw = localStorage.getItem(LEGACY_KEY)
    localStorage.clear()
    localStorage.setItem(LEGACY_KEY, raw as string)
    expect(loadLayout(false, 1).panes[0]?.sessionId).toBe("old")
  })

  it("gives each window its own layout", () => {
    saveLayout(layout("a"), 1)
    saveLayout(layout("b"), 2)
    saveLayout(layout("c"), 3)

    expect(loadLayout(false, 1).panes[0]?.sessionId).toBe("a")
    expect(loadLayout(false, 2).panes[0]?.sessionId).toBe("b")
    expect(loadLayout(false, 3).panes[0]?.sessionId).toBe("c")
  })

  it("does not leak one window's layout into another", () => {
    saveLayout(layout("a"), 1)
    saveLayout(layout("b"), 2)
    saveLayout(layout("b2"), 2)
    expect(loadLayout(false, 1).panes[0]?.sessionId).toBe("a")
  })

  it("leaves a window with no stored layout on the solo fallback", () => {
    saveLayout(layout("a"), 1)
    expect(hasStoredLayout(2)).toBe(false)
    expect(loadLayout(true, 2)).toEqual(soloLayout(null, true))
  })

  it("survives a restart: every window reopens on its own panes", () => {
    saveLayout(layout("a"), 1)
    saveLayout(layout("b"), 2)
    saveLayout(layout("c"), 3)

    const reopened = [1, 2, 3].map((id) => loadLayout(false, id))
    expect(reopened.map((l) => l.panes[0]?.sessionId)).toEqual(["a", "b", "c"])
  })

  it("closing one window leaves the others' layouts alone", () => {
    saveLayout(layout("a"), 1)
    saveLayout(layout("b"), 2)
    saveLayout(layout("c"), 3)

    localStorage.removeItem(layoutKey(2))

    expect(hasStoredLayout(1)).toBe(true)
    expect(hasStoredLayout(3)).toBe(true)
    expect(loadLayout(false, 1).panes[0]?.sessionId).toBe("a")
    expect(loadLayout(false, 3).panes[0]?.sessionId).toBe("c")
  })
})

describe("per-window dock state", () => {
  it("keeps window 1 on the key the app already wrote", () => {
    saveDockOpen(true, 1)
    expect(localStorage.getItem("chat-hub.surfaceDock.open")).toBe("1")
  })

  it("lets two windows disagree about whether the dock is open", () => {
    saveDockOpen(true, 1)
    saveDockOpen(false, 2)
    expect(loadDockOpen(1)).toBe(true)
    expect(loadDockOpen(2)).toBe(false)
  })

  it("defaults a window that has never written to closed", () => {
    saveDockOpen(true, 1)
    expect(loadDockOpen(4)).toBe(false)
  })
})
