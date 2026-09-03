import type { BrowserResponse } from "./browser"
import type { SurfaceKind } from "./surfaces"

export const HUB_OP_PREFIX = "hub."

export const HUB_OPS = {
  listWindows: "hub.list-windows",
  openWindow: "hub.open-window",
  focusSession: "hub.focus-session",
  setLayout: "hub.set-layout",
  openSurface: "hub.open-surface",
  arrange: "hub.arrange",
} as const

export type HubOp = (typeof HUB_OPS)[keyof typeof HUB_OPS]

export const HUB_MCP_SERVER_NAME = "chathub-hub"

export const HUB_MAX_PANES = 6

export const HUB_SURFACE_CHOICES = [
  "diff",
  "terminal",
  "editor",
  "browser",
] as const

export type HubSurfaceChoice = (typeof HUB_SURFACE_CHOICES)[number]

export const HUB_PRESETS = ["review", "monitor", "deep-work"] as const

export type HubPreset = (typeof HUB_PRESETS)[number]

export const HUB_CONTROL_DISABLED_MESSAGE =
  'Hub UI control is turned off. Enable "Allow agents to control the Hub UI" in Chat Hub settings to use hub tools.'

export function isHubOp(op: string): boolean {
  return op.startsWith(HUB_OP_PREFIX)
}

export type HubRequest = {
  id: string
  sessionId: string
  op: string
  params: Record<string, unknown>
}

export type HubResponse = BrowserResponse

export type HubPaneSpec = {
  sessionId: string
  dockOpen: boolean | null
  surface: SurfaceKind | null
}

export type HubLayoutCommand = {
  windowId: number
  panes: HubPaneSpec[]
  focusSessionId: string | null
  at: number
}

export type HubWindowSnapshot = {
  id: number
  focused: boolean
  sessionIds: string[]
}

export function surfaceForChoice(choice: HubSurfaceChoice): SurfaceKind {
  return choice === "editor" ? "files" : choice
}

export type HubParse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

function invalid<T>(error: string): HubParse<T> {
  return { ok: false, error }
}

export function parseHubSessionId(value: unknown): HubParse<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid('"sessionId" must be a non-empty session id string.')
  }
  return { ok: true, value: value.trim() }
}

export function parseHubWindowId(
  value: unknown,
  opts: { required: boolean },
): HubParse<number | null> {
  if (value === undefined || value === null) {
    return opts.required
      ? invalid('"windowId" is required — read the ids from hub_list_windows.')
      : { ok: true, value: null }
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return invalid('"windowId" must be a whole window id, 1 or greater.')
  }
  return { ok: true, value }
}

export function parseHubPanes(value: unknown): HubParse<string[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid('"panes" must be a non-empty array of { sessionId } entries.')
  }
  if (value.length > HUB_MAX_PANES) {
    return invalid(
      `A window holds at most ${HUB_MAX_PANES} panes; ${value.length} were given.`,
    )
  }
  const sessionIds: string[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return invalid('Every pane must be an object of the shape { sessionId }.')
    }
    const sessionId = (entry as Record<string, unknown>).sessionId
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      return invalid('Every pane needs a non-empty "sessionId".')
    }
    if (sessionIds.includes(sessionId)) {
      return invalid(
        `Session ${JSON.stringify(sessionId)} appears twice; a session shows in one pane at a time.`,
      )
    }
    sessionIds.push(sessionId)
  }
  return { ok: true, value: sessionIds }
}

export function parseHubSurfaceChoice(
  value: unknown,
): HubParse<HubSurfaceChoice> {
  if (
    typeof value === "string" &&
    (HUB_SURFACE_CHOICES as readonly string[]).includes(value)
  ) {
    return { ok: true, value: value as HubSurfaceChoice }
  }
  return invalid(
    `"surface" must be one of: ${HUB_SURFACE_CHOICES.join(", ")}.`,
  )
}

export function parseHubPreset(value: unknown): HubParse<HubPreset> {
  if (
    typeof value === "string" &&
    (HUB_PRESETS as readonly string[]).includes(value)
  ) {
    return { ok: true, value: value as HubPreset }
  }
  return invalid(`"preset" must be one of: ${HUB_PRESETS.join(", ")}.`)
}

export function frontWindow(
  windows: readonly HubWindowSnapshot[],
  recency: readonly number[],
): HubWindowSnapshot | null {
  const focused = windows.find((w) => w.focused)
  if (focused) return focused
  for (let i = recency.length - 1; i >= 0; i -= 1) {
    const match = windows.find((w) => w.id === recency[i])
    if (match) return match
  }
  return windows[0] ?? null
}

export function arrangeSessionFor(
  window: HubWindowSnapshot | null,
  activeSessionId: string | null,
): string | null {
  if (activeSessionId && window?.sessionIds.includes(activeSessionId)) {
    return activeSessionId
  }
  return window?.sessionIds[0] ?? activeSessionId
}

export function arrangePanes(
  preset: HubPreset,
  sessionId: string,
): HubPaneSpec[] {
  switch (preset) {
    case "review":
      return [{ sessionId, dockOpen: true, surface: "diff" }]
    case "monitor":
      return [{ sessionId, dockOpen: true, surface: "fleet" }]
    case "deep-work":
      return [{ sessionId, dockOpen: false, surface: null }]
  }
}
