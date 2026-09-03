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

import { connect } from "node:net"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { resolve as resolvePath } from "node:path"

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

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

function toolCatalogue() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}

function unavailableError(cause) {
  const err = new Error(UNREACHABLE_MESSAGE)
  err.code = "hub-unavailable"
  if (cause) err.cause = cause
  return err
}

let socket = null
let connecting = null
let socketBuffer = ""
const pending = new Map()

function failPending(err) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.reject(err)
  }
  pending.clear()
}

function consumeSocketChunk(chunk) {
  socketBuffer += chunk
  let index = socketBuffer.indexOf("\n")
  while (index !== -1) {
    const line = socketBuffer.slice(0, index).replace(/\r$/, "")
    socketBuffer = socketBuffer.slice(index + 1)
    if (line.trim()) settleResponse(line)
    index = socketBuffer.indexOf("\n")
  }
}

function settleResponse(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.stderr.write(`[chathub-hub] unparsable socket line\n`)
    return
  }
  const entry = message && typeof message.id === "string" ? pending.get(message.id) : undefined
  if (!entry) return
  pending.delete(message.id)
  clearTimeout(entry.timer)
  entry.resolve(message)
}

function ensureSocket() {
  if (socket && !socket.destroyed) return Promise.resolve(socket)
  if (connecting) return connecting
  const path = process.env[BROWSER_SOCKET_ENV] ?? ""
  if (!path) return Promise.reject(unavailableError())

  connecting = new Promise((resolveSocket, rejectSocket) => {
    const next = connect(path)
    let opened = false
    next.setEncoding("utf8")
    next.on("connect", () => {
      opened = true
      socket = next
      socketBuffer = ""
      connecting = null
      resolveSocket(next)
    })
    next.on("data", (chunk) => consumeSocketChunk(chunk))
    next.on("error", (err) => {
      next.destroy()
      if (!opened) {
        connecting = null
        rejectSocket(unavailableError(err))
      }
    })
    next.on("close", () => {
      if (socket === next) {
        socket = null
        socketBuffer = ""
      }
      if (!opened) {
        connecting = null
        rejectSocket(unavailableError())
      }
      failPending(unavailableError())
    })
  })
  return connecting
}

function closeSocket() {
  if (socket) socket.destroy()
  socket = null
  connecting = null
}

async function callHub(op, params) {
  const open = await ensureSocket()
  const id = randomUUID()
  const request = {
    id,
    sessionId: process.env[BROWSER_SESSION_ENV] ?? "",
    op,
    params,
  }
  const budget = HUB_OP_TIMEOUT_MS + TIMEOUT_MARGIN_MS
  return new Promise((resolveCall, rejectCall) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectCall(new Error(`Chat Hub did not answer ${op} within ${budget} ms.`))
    }, budget)
    if (typeof timer.unref === "function") timer.unref()
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
    open.write(`${JSON.stringify(request)}\n`, (err) => {
      if (!err) return
      pending.delete(id)
      clearTimeout(timer)
      rejectCall(unavailableError(err))
    })
  })
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== ""
}

function validateArgs(tool, args) {
  for (const key of tool.inputSchema.required ?? []) {
    if (!isPresent(args[key])) return `${tool.name} requires "${key}".`
  }
  return null
}

function buildParams(tool, args) {
  const params = {}
  for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
    if (args[key] !== undefined) params[key] = args[key]
  }
  return params
}

function textResult(text) {
  return { content: [{ type: "text", text }] }
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true }
}

function shapeResult(result) {
  if (typeof result.summary === "string" && result.summary) {
    return textResult(result.summary)
  }
  const keys = Object.keys(result)
  if (keys.length === 0) return textResult("ok")
  return textResult(JSON.stringify(result))
}

async function callTool(name, rawArgs) {
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) return null
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {}
  const invalid = validateArgs(tool, args)
  if (invalid) return errorResult(invalid)

  let response
  try {
    response = await callHub(tool.op, buildParams(tool, args))
  } catch (err) {
    if (err && err.code === "hub-unavailable") {
      return errorResult(UNREACHABLE_MESSAGE)
    }
    return errorResult(err instanceof Error ? err.message : String(err))
  }

  if (!response || response.ok !== true) {
    const detail = response && typeof response.error === "string" ? response.error : "unknown error"
    return errorResult(`${name} failed: ${detail}`)
  }
  const result =
    response.result && typeof response.result === "object" && !Array.isArray(response.result)
      ? response.result
      : {}
  return shapeResult(result)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })
}

function initializeResult(params) {
  const asked = params && typeof params.protocolVersion === "string" ? params.protocolVersion : ""
  return {
    protocolVersion: KNOWN_PROTOCOL_VERSIONS.has(asked) ? asked : DEFAULT_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: HUB_MCP_SERVER_NAME, version: SERVER_VERSION },
  }
}

async function dispatch(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    replyError(null, -32600, "Invalid Request")
    return
  }
  const { id, method, params } = message
  const isNotification = id === undefined || id === null
  if (typeof method !== "string") {
    if (!isNotification) replyError(id, -32600, "Invalid Request")
    return
  }

  switch (method) {
    case "initialize":
      if (!isNotification) reply(id, initializeResult(params))
      return
    case "notifications/initialized":
    case "notifications/cancelled":
      return
    case "ping":
      if (!isNotification) reply(id, {})
      return
    case "tools/list":
      if (!isNotification) reply(id, { tools: toolCatalogue() })
      return
    case "tools/call": {
      if (isNotification) return
      const name = params && typeof params.name === "string" ? params.name : ""
      const result = await callTool(name, params?.arguments)
      if (!result) {
        replyError(id, -32602, `Unknown tool: ${name || "(missing name)"}`)
        return
      }
      reply(id, result)
      return
    }
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`)
  }
}

function main() {
  let stdinBuffer = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    stdinBuffer += chunk
    let index = stdinBuffer.indexOf("\n")
    while (index !== -1) {
      const line = stdinBuffer.slice(0, index).replace(/\r$/, "")
      stdinBuffer = stdinBuffer.slice(index + 1)
      index = stdinBuffer.indexOf("\n")
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        replyError(null, -32700, "Parse error")
        continue
      }
      void dispatch(message).catch((err) => {
        process.stderr.write(`[chathub-hub] dispatch failed: ${String(err)}\n`)
      })
    }
  })
  process.stdin.on("end", () => {
    closeSocket()
    process.exit(0)
  })
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[chathub-hub] ${String(err)}\n`)
  })
}

const entryPath = process.argv[1] ? resolvePath(process.argv[1]) : ""
if (entryPath && entryPath === fileURLToPath(import.meta.url)) main()
