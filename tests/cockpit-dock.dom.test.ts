import { act, createElement, useState, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SurfaceKind } from "@shared/surfaces"
import { WorkspacePane, type PaneActions } from "../src/renderer/src/components/WorkspacePane"

vi.mock("../src/renderer/src/components/ChatView", () => ({
  ChatView: ({ onToggleDock, onCommit }: { onToggleDock: () => void; onCommit: () => void }) => createElement("div", null,
    createElement("button", { onClick: onToggleDock, "data-testid": "toggle-dock" }, "Toggle panel"),
    createElement("button", { onClick: onCommit }, "Review changes")),
}))
vi.mock("../src/renderer/src/components/surfaces/SurfaceDock", () => ({
  SurfaceDock: ({ kind, onClose, onSelectKind }: { kind: SurfaceKind | null; onClose: () => void; onSelectKind: (kind: SurfaceKind) => void }) => createElement("aside", { "data-testid": "dock", "data-kind": kind ?? "chooser" },
    createElement("button", { onClick: onClose }, "Close panel"),
    createElement("button", { onClick: () => onSelectKind("design") }, "Design surface")),
}))

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
let host: HTMLDivElement
let openFromAgent: (surface: SurfaceKind) => void

function mount(initialSurface: SurfaceKind | null = null) {
  host = document.createElement("div")
  document.body.append(host)
  function Harness() {
    const [dockOpen, setDockOpen] = useState(false)
    const [surface, setSurface] = useState(initialSurface)
    openFromAgent = (kind) => { setSurface(kind); setDockOpen(true) }
    const actions = {
      onToggleDock: () => setDockOpen((open) => !open),
      onSelectSurface: (_paneId: string, _sessionId: string, kind: SurfaceKind | null) => setSurface(kind),
    } as PaneActions
    const props = {
      pane: { id: "pane", sessionId: "s1", dockOpen },
      variant: "solo", cockpit: true, focused: true,
      session: { id: "s1", provider: "mock", title: "Design review", cwd: "/project", project: "project", status: "idle", createdAt: 0, updatedAt: 0 },
      surface, messages: [], actions, sessions: [], models: [], modes: [], providers: [], queued: [], permissions: [], inputRequests: [], hookRuns: [], scripts: [],
      usageBySession: {}, queuedBySession: {},
    } as ComponentProps<typeof WorkspacePane>
    return createElement(WorkspacePane, props)
  }
  root = createRoot(host)
  void act(() => root?.render(createElement(Harness)))
}

function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === text)
  expect(button, `button ${text}`).toBeTruthy()
  void act(() => button?.click())
}

afterEach(() => {
  void act(() => root?.unmount())
  root = undefined
  host?.remove()
})

describe("cockpit dock visibility", () => {
  it("opens the chooser from the panel toggle and displays a selected Design surface", () => {
    mount()
    expect(host.querySelector("[data-testid=dock]")).toBeNull()
    click("Toggle panel")
    expect(host.querySelector("[data-testid=dock]")?.getAttribute("data-kind")).toBe("chooser")
    click("Design surface")
    expect(host.querySelector("[data-testid=dock]")?.getAttribute("data-kind")).toBe("design")
    expect(host.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Panels")
    click("Close panel")
    expect(host.querySelector("[data-testid=dock]")).toBeNull()
    click("Toggle panel")
    expect(host.querySelector("[data-testid=dock]")?.getAttribute("data-kind")).toBe("design")
  })
  it("keeps tabs and dock state synchronized while switching to and from chat", () => {
    mount()
    click("Browser")
    expect(host.querySelector("[data-testid=dock]")?.getAttribute("data-kind")).toBe("browser")
    click("Chat")
    expect(host.querySelector("[data-testid=dock]")).toBeNull()
    click("Toggle panel")
    expect(host.querySelector("[data-testid=dock]")?.getAttribute("data-kind")).toBe("browser")
    click("Panels")
    expect(host.querySelector("[data-testid=dock]")?.getAttribute("data-kind")).toBe("chooser")
  })
  it("opens Diff from a chat action when the dock is closed", () => {
    mount()
    click("Review changes")
    expect(host.querySelector("[data-testid=dock]")?.getAttribute("data-kind")).toBe("diff")
  })
  it("shows a non-tab surface requested by the agent", () => {
    mount()
    void act(() => openFromAgent("design"))
    expect(host.querySelector("[data-testid=dock]")?.getAttribute("data-kind")).toBe("design")
    expect(host.querySelector(".cockpit-chat")?.hasAttribute("hidden")).toBe(true)
  })
})
