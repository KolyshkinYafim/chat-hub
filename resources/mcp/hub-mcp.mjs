export const BROWSER_SOCKET_ENV = "CHATHUB_BROWSER_SOCKET"
export const BROWSER_SESSION_ENV = "CHATHUB_BROWSER_SESSION"
export const HUB_MCP_SERVER_NAME = "chathub-hub"
export const HUB_OP_TIMEOUT_MS = 30_000
export const HUB_MAX_PANES = 6
export const HUB_OPS = {
  listWindows: "hub.list-windows",
  openWindow: "hub.open-window",
  focusSession: "hub.focus-session",
  setLayout: "hub.set-layout",
  openSurface: "hub.open-surface",
  arrange: "hub.arrange",
}
export const HUB_SURFACE_CHOICES = ["diff", "terminal", "editor", "browser"]
export const HUB_PRESETS = ["review", "monitor", "deep-work"]

import { fileURLToPath } from "node:url"
import { resolve as resolvePath } from "node:path"
import {
  createMcpRuntime,
  textResult,
} from "./socket-mcp-runtime.mjs"

const SERVER_VERSION = "1.0.0"
const DEFAULT_PROTOCOL_VERSION = "2024-11-05"
const KNOWN_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
])

const TIMEOUT_MARGIN_MS = 2_000

const UNREACHABLE_MESSAGE =
  "Chat Hub is not reachable, so its windows cannot be driven from here."

const TOOLS = [
  {
    name: "hub_list_windows",
    op: HUB_OPS.listWindows,
    description:
      "List Chat Hub's open windows: each window's id, whether it is focused, and the sessions it shows.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hub_open_window",
    op: HUB_OPS.openWindow,
    description:
      "Open a new Chat Hub window, empty or seeded with one session, and report its window id.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session to show in the new window's first pane.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "hub_focus_session",
    op: HUB_OPS.focusSession,
    description:
      "Bring a session on screen — in the window that already shows it, or in the window named by windowId.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session to focus." },
        windowId: {
          type: "number",
          description: "Window to focus it in; defaults to wherever it lives.",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "hub_set_layout",
    op: HUB_OPS.setLayout,
    description: `Set one window's chat panes left to right, one session per pane, up to ${HUB_MAX_PANES}.`,
    inputSchema: {
      type: "object",
      properties: {
        windowId: {
          type: "number",
          description: "Window to lay out, from hub_list_windows.",
        },
        panes: {
          type: "array",
          description: "Panes left to right.",
          items: {
            type: "object",
            properties: {
              sessionId: { type: "string", description: "Session for this pane." },
            },
            required: ["sessionId"],
            additionalProperties: false,
          },
        },
      },
      required: ["windowId", "panes"],
      additionalProperties: false,
    },
  },
  {
    name: "hub_open_surface",
    op: HUB_OPS.openSurface,
    description:
      "Open a side panel for a session: diff, terminal, editor or browser. Only moves the panel when that session is on screen.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session whose panel to open." },
        surface: {
          type: "string",
          enum: HUB_SURFACE_CHOICES,
          description: "Which panel to show.",
        },
      },
      required: ["sessionId", "surface"],
      additionalProperties: false,
    },
  },
  {
    name: "hub_arrange",
    op: HUB_OPS.arrange,
    description:
      "Apply a layout preset to the front window: review (chat plus open diff), monitor (fleet overview), or deep-work (one solo pane, panels closed).",
    inputSchema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: HUB_PRESETS,
          description: "Which arrangement to apply.",
        },
      },
      required: ["preset"],
      additionalProperties: false,
    },
  },
]

function shapeResult(_tool, result) {
  if (typeof result.summary === "string" && result.summary) {
    return textResult(result.summary)
  }
  const keys = Object.keys(result)
  if (keys.length === 0) return textResult("ok")
  return textResult(JSON.stringify(result))
}

const runtime = createMcpRuntime({
  tag: "chathub-hub",
  unavailableCode: "hub-unavailable",
  socketEnv: BROWSER_SOCKET_ENV,
  sessionEnv: BROWSER_SESSION_ENV,
  opTimeoutMs: HUB_OP_TIMEOUT_MS,
  timeoutMarginMs: TIMEOUT_MARGIN_MS,
  serverName: HUB_MCP_SERVER_NAME,
  serverVersion: SERVER_VERSION,
  defaultProtocolVersion: DEFAULT_PROTOCOL_VERSION,
  knownProtocolVersions: KNOWN_PROTOCOL_VERSIONS,
  tools: TOOLS,
  unreachableFor: () => UNREACHABLE_MESSAGE,
  shapeResult,
})

const entryPath = process.argv[1] ? resolvePath(process.argv[1]) : ""
if (entryPath && entryPath === fileURLToPath(import.meta.url)) runtime.main()
