import { describe, expect, it } from "vitest"
import {
  HUB_CONTROL_DISABLED_MESSAGE,
  HUB_MAX_PANES,
  HUB_OPS,
  arrangePanes,
  arrangeSessionFor,
  frontWindow,
  isHubOp,
  parseHubPanes,
  parseHubPreset,
  parseHubSessionId,
  parseHubSurfaceChoice,
  parseHubWindowId,
  surfaceForChoice,
  type HubLayoutCommand,
  type HubRequest,
  type HubWindowSnapshot,
} from "@shared/hub-control"
import { MAX_PANES } from "@renderer/lib/pane-layout"
import { HubControl, type HubControlDeps } from "../src/main/hub-control"

describe("hub op namespace", () => {
  it("matches every hub op and nothing else", () => {
    for (const op of Object.values(HUB_OPS)) expect(isHubOp(op)).toBe(true)
    expect(isHubOp("surface.open")).toBe(false)
    expect(isHubOp("navigate")).toBe(false)
  })

  it("caps panes at the workspace's own pane limit", () => {
    expect(HUB_MAX_PANES).toBe(MAX_PANES)
  })
})

describe("parseHubSessionId", () => {
  it("accepts a session id and trims it", () => {
    expect(parseHubSessionId(" s-1 ")).toEqual({ ok: true, value: "s-1" })
  })

  it.each([undefined, null, "", "   ", 7, {}])(
    "rejects %j",
    (value) => {
      expect(parseHubSessionId(value).ok).toBe(false)
    },
  )
})

describe("parseHubWindowId", () => {
  it("treats a missing optional id as null", () => {
    expect(parseHubWindowId(undefined, { required: false })).toEqual({
      ok: true,
      value: null,
    })
  })

  it("demands a missing required id", () => {
    const parsed = parseHubWindowId(undefined, { required: true })
    expect(parsed.ok).toBe(false)
  })

  it("accepts a positive integer", () => {
    expect(parseHubWindowId(3, { required: true })).toEqual({ ok: true, value: 3 })
  })

  it.each([0, -1, 1.5, "2", true])("rejects %j", (value) => {
    expect(parseHubWindowId(value, { required: false }).ok).toBe(false)
  })
})

describe("parseHubPanes", () => {
  it("returns the session ids in order", () => {
    const parsed = parseHubPanes([{ sessionId: "a" }, { sessionId: "b" }])
    expect(parsed).toEqual({ ok: true, value: ["a", "b"] })
  })

  it("rejects an empty array and a non-array", () => {
    expect(parseHubPanes([]).ok).toBe(false)
    expect(parseHubPanes("panes").ok).toBe(false)
  })

  it("rejects more panes than a window holds", () => {
    const specs = Array.from({ length: HUB_MAX_PANES + 1 }, (_, i) => ({
      sessionId: `s-${i}`,
    }))
    const parsed = parseHubPanes(specs)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain(String(HUB_MAX_PANES))
  })

  it("rejects a pane without a session id", () => {
    expect(parseHubPanes([{ sessionId: "" }]).ok).toBe(false)
    expect(parseHubPanes([{}]).ok).toBe(false)
    expect(parseHubPanes([null]).ok).toBe(false)
  })

  it("rejects the same session twice", () => {
    const parsed = parseHubPanes([{ sessionId: "a" }, { sessionId: "a" }])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('"a"')
  })
})

describe("parseHubSurfaceChoice", () => {
  it.each(["diff", "terminal", "editor", "browser"])("accepts %s", (value) => {
    expect(parseHubSurfaceChoice(value)).toEqual({ ok: true, value })
  })

  it.each(["fleet", "board", "", 4])("rejects %j", (value) => {
    expect(parseHubSurfaceChoice(value).ok).toBe(false)
  })

  it("maps editor to the files surface and keeps the rest", () => {
    expect(surfaceForChoice("editor")).toBe("files")
    expect(surfaceForChoice("diff")).toBe("diff")
    expect(surfaceForChoice("terminal")).toBe("terminal")
    expect(surfaceForChoice("browser")).toBe("browser")
  })
})

describe("parseHubPreset", () => {
  it.each(["review", "monitor", "deep-work"])("accepts %s", (value) => {
    expect(parseHubPreset(value)).toEqual({ ok: true, value })
  })

  it.each(["focus", "", null])("rejects %j", (value) => {
    expect(parseHubPreset(value).ok).toBe(false)
  })
})

const win = (
  id: number,
  focused: boolean,
  sessionIds: string[] = [],
): HubWindowSnapshot => ({ id, focused, sessionIds })

describe("frontWindow", () => {
  it("prefers the focused window", () => {
    const picked = frontWindow([win(1, false), win(2, true)], [1, 2])
    expect(picked?.id).toBe(2)
  })

  it("falls back to the most recently used window", () => {
    const picked = frontWindow([win(1, false), win(2, false)], [2, 1])
    expect(picked?.id).toBe(1)
  })

  it("ignores recency entries for windows that are gone", () => {
    const picked = frontWindow([win(3, false)], [1, 2])
    expect(picked?.id).toBe(3)
  })

  it("answers null with no windows", () => {
    expect(frontWindow([], [])).toBeNull()
  })
})

describe("arrangeSessionFor", () => {
  it("keeps the active session when the front window shows it", () => {
    expect(arrangeSessionFor(win(1, true, ["a", "b"]), "b")).toBe("b")
  })

  it("takes the window's first session when the active one lives elsewhere", () => {
    expect(arrangeSessionFor(win(1, true, ["a"]), "z")).toBe("a")
  })

  it("falls back to the active session with no window", () => {
    expect(arrangeSessionFor(null, "z")).toBe("z")
  })

  it("answers null with nothing to go on", () => {
    expect(arrangeSessionFor(win(1, true, []), null)).toBeNull()
  })
})

describe("arrangePanes", () => {
  it("review pairs the session with an open diff panel", () => {
    expect(arrangePanes("review", "s")).toEqual([
      { sessionId: "s", dockOpen: true, surface: "diff" },
    ])
  })

  it("monitor opens the fleet overview", () => {
    expect(arrangePanes("monitor", "s")).toEqual([
      { sessionId: "s", dockOpen: true, surface: "fleet" },
    ])
  })

  it("deep-work closes the dock", () => {
    expect(arrangePanes("deep-work", "s")).toEqual([
      { sessionId: "s", dockOpen: false, surface: null },
    ])
  })
})

type FakeState = {
  applied: HubLayoutCommand[]
  focused: Array<{ sessionId: string; windowId: number | null }>
  opened: Array<string | null>
  surfaced: Array<{ sessionId: string; surface: string }>
}

function makeControl(
  overrides: Partial<HubControlDeps> = {},
): { control: HubControl; state: FakeState } {
  const state: FakeState = { applied: [], focused: [], opened: [], surfaced: [] }
  const sessions = new Map([
    ["s-1", { id: "s-1", title: "Fix auth" }],
    ["s-2", { id: "s-2", title: "Write docs" }],
  ])
  const control = new HubControl({
    enabled: () => true,
    windows: () => [win(1, true, ["s-1"]), win(2, false, ["s-2"])],
    recency: () => [2, 1],
    session: (id) => sessions.get(id) ?? null,
    activeSessionId: () => "s-1",
    openWindow: (sessionId) => {
      state.opened.push(sessionId)
      return 9
    },
    focusSession: (sessionId, windowId) => {
      state.focused.push({ sessionId, windowId })
      return windowId ?? 1
    },
    applyLayout: (command) => {
      state.applied.push(command)
    },
    openSurface: (request, surface) => {
      state.surfaced.push({ sessionId: request.sessionId, surface })
      return Promise.resolve({
        id: request.id,
        ok: true,
        result: { summary: `opened ${surface}` },
      })
    },
    ...overrides,
  })
  return { control, state }
}

function req(op: string, params: Record<string, unknown> = {}): HubRequest {
  return { id: "r-1", sessionId: "s-1", op, params }
}

describe("HubControl", () => {
  it("refuses every op while the settings toggle is off", async () => {
    const { control } = makeControl({ enabled: () => false })
    const response = await control.handle(req(HUB_OPS.listWindows))
    expect(response).toEqual({
      id: "r-1",
      ok: false,
      error: HUB_CONTROL_DISABLED_MESSAGE,
    })
  })

  it("lists windows with ids, focus and session titles", async () => {
    const { control } = makeControl()
    const response = await control.handle(req(HUB_OPS.listWindows))
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.result.summary).toContain("Window 1 (focused)")
    expect(response.result.summary).toContain('"Fix auth" (s-1)')
    expect(response.result.windows).toEqual([
      {
        id: 1,
        focused: true,
        sessions: [{ id: "s-1", title: "Fix auth" }],
      },
      {
        id: 2,
        focused: false,
        sessions: [{ id: "s-2", title: "Write docs" }],
      },
    ])
  })

  it("answers an unknown op with a typed error, not a throw", async () => {
    const { control } = makeControl()
    const response = await control.handle(req("hub.teleport"))
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error).toContain("hub.teleport")
  })

  it("opens a window seeded with a validated session", async () => {
    const { control, state } = makeControl()
    const response = await control.handle(
      req(HUB_OPS.openWindow, { sessionId: "s-2" }),
    )
    expect(state.opened).toEqual(["s-2"])
    expect(response.ok).toBe(true)
    if (response.ok) expect(response.result.windowId).toBe(9)
  })

  it("refuses to open a window for a session that does not exist", async () => {
    const { control, state } = makeControl()
    const response = await control.handle(
      req(HUB_OPS.openWindow, { sessionId: "ghost" }),
    )
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error).toContain('"ghost"')
    expect(state.opened).toEqual([])
  })

  it("focuses a session in its own window when no window is named", async () => {
    const { control, state } = makeControl()
    const response = await control.handle(
      req(HUB_OPS.focusSession, { sessionId: "s-2" }),
    )
    expect(state.focused).toEqual([{ sessionId: "s-2", windowId: null }])
    expect(response.ok).toBe(true)
  })

  it("rejects focusing into a window that is not open", async () => {
    const { control, state } = makeControl()
    const response = await control.handle(
      req(HUB_OPS.focusSession, { sessionId: "s-1", windowId: 7 }),
    )
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error).toContain("7")
    expect(state.focused).toEqual([])
  })

  it("applies a validated layout to the named window", async () => {
    const { control, state } = makeControl()
    const response = await control.handle(
      req(HUB_OPS.setLayout, {
        windowId: 2,
        panes: [{ sessionId: "s-2" }, { sessionId: "s-1" }],
      }),
    )
    expect(response.ok).toBe(true)
    expect(state.applied).toHaveLength(1)
    expect(state.applied[0]).toMatchObject({
      windowId: 2,
      focusSessionId: "s-2",
      panes: [
        { sessionId: "s-2", dockOpen: null, surface: null },
        { sessionId: "s-1", dockOpen: null, surface: null },
      ],
    })
  })

  it("rejects a layout naming a dead session and applies nothing", async () => {
    const { control, state } = makeControl()
    const response = await control.handle(
      req(HUB_OPS.setLayout, {
        windowId: 1,
        panes: [{ sessionId: "s-1" }, { sessionId: "ghost" }],
      }),
    )
    expect(response.ok).toBe(false)
    expect(state.applied).toEqual([])
  })

  it("rejects a layout with too many panes", async () => {
    const { control, state } = makeControl()
    const panes = Array.from({ length: HUB_MAX_PANES + 1 }, (_, i) => ({
      sessionId: `s-${i}`,
    }))
    const response = await control.handle(
      req(HUB_OPS.setLayout, { windowId: 1, panes }),
    )
    expect(response.ok).toBe(false)
    expect(state.applied).toEqual([])
  })

  it("maps the editor choice onto the files surface", async () => {
    const { control, state } = makeControl()
    const response = await control.handle(
      req(HUB_OPS.openSurface, { sessionId: "s-1", surface: "editor" }),
    )
    expect(state.surfaced).toEqual([{ sessionId: "s-1", surface: "files" }])
    expect(response.ok).toBe(true)
  })

  it("rejects a surface outside the hub's set", async () => {
    const { control, state } = makeControl()
    const response = await control.handle(
      req(HUB_OPS.openSurface, { sessionId: "s-1", surface: "board" }),
    )
    expect(response.ok).toBe(false)
    expect(state.surfaced).toEqual([])
  })

  it("arranges the review preset on the front window's active session", async () => {
    const { control, state } = makeControl()
    const response = await control.handle(
      req(HUB_OPS.arrange, { preset: "review" }),
    )
    expect(response.ok).toBe(true)
    expect(state.applied[0]).toMatchObject({
      windowId: 1,
      focusSessionId: "s-1",
      panes: [{ sessionId: "s-1", dockOpen: true, surface: "diff" }],
    })
  })

  it("arranges into a fresh window when none is open", async () => {
    const { control, state } = makeControl({
      windows: () => [],
      recency: () => [],
    })
    const response = await control.handle(
      req(HUB_OPS.arrange, { preset: "deep-work" }),
    )
    expect(response.ok).toBe(true)
    expect(state.opened).toEqual(["s-1"])
    expect(state.applied[0]).toMatchObject({ windowId: 9 })
  })

  it("says what is missing when nothing can be arranged", async () => {
    const { control } = makeControl({
      windows: () => [],
      recency: () => [],
      activeSessionId: () => null,
    })
    const response = await control.handle(
      req(HUB_OPS.arrange, { preset: "monitor" }),
    )
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error).toContain("hub_focus_session")
  })
})
