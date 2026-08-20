/*
 * SHARED CONTRACT — duplicated from src/shared/browser.ts, src/shared/surface-
 * control.ts and src/shared/surfaces.ts, which are the source of truth. This
 * file is spawned as plain Node (ELECTRON_RUN_AS_NODE=1) and cannot import
 * TypeScript, so the values below are copies. tests/browser-mcp-server.test.ts
 * and tests/surface-mcp-server.test.ts assert they still equal the TypeScript
 * originals, including the snapshot renderer's byte-for-byte output. Change
 * the TypeScript first, then mirror it here.
 */

export const BROWSER_SOCKET_ENV = "CHATHUB_BROWSER_SOCKET"
export const BROWSER_SESSION_ENV = "CHATHUB_BROWSER_SESSION"
export const BROWSER_MCP_SERVER_NAME = "chathub-browser"
export const BROWSER_SNAPSHOT_CHAR_LIMIT = 24_000
export const BROWSER_TEXT_CHAR_LIMIT = 24_000
export const BROWSER_OP_TIMEOUT_MS = 30_000
export const BROWSER_MODIFIERS = ["shift", "control", "alt", "meta"]

export const SURFACE_OP_PREFIX = "surface."
export const SURFACE_OPS = {
  open: "surface.open",
  close: "surface.close",
  status: "surface.status",
  script: "surface.script",
  boardAdd: "surface.board-add",
  boardCheck: "surface.board-check",
}
export const SURFACE_KINDS = [
  "board",
  "context",
  "browser",
  "terminal",
  "files",
  "diff",
  "history",
  "fleet",
]

export function renderSnapshot(snapshot) {
  const head = `url: ${snapshot.url}\ntitle: ${snapshot.title}\n`
  const body = snapshot.nodes
    .map((node) => {
      const indent = "  ".repeat(node.depth)
      const parts = [`${node.role} ${JSON.stringify(node.name)}`]
      if (node.value !== undefined) parts.push(`value=${JSON.stringify(node.value)}`)
      if (node.checked !== undefined) parts.push(`checked=${node.checked}`)
      if (node.disabled) parts.push("disabled")
      return `${indent}- ${parts.join(" ")} [${node.ref}]`
    })
    .join("\n")
  const tail = snapshot.truncated ? "\n… snapshot truncated" : ""
  return `${head}${body}${tail}`
}

/* END SHARED CONTRACT */

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
  "Chat Hub's browser surface is not reachable. Open the Browser surface in Chat Hub and retry."

const SURFACE_UNREACHABLE_MESSAGE =
  "Chat Hub is not reachable, so its panels cannot be opened from here."

const POINTER_HINT =
  'point at an element with "ref" from browser_snapshot, or give both "x" and "y"'

const MODIFIER_SCHEMA = {
  type: "array",
  items: { type: "string", enum: BROWSER_MODIFIERS },
  description: "Modifier keys held during the action.",
}

const TOOLS = [
  {
    name: "browser_navigate",
    op: "navigate",
    description:
      'Load a url in the Chat Hub browser, or pass "back", "forward" or "reload" to move through history.',
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: 'Absolute url, or one of "back", "forward", "reload".',
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    op: "snapshot",
    description:
      "Read the page as a ref-tagged accessibility tree; every other tool points at elements by those refs.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["interactive", "all"],
          description: "Interactive elements only (default), or the whole tree.",
        },
        limit: { type: "number", description: "Maximum number of nodes to return." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    op: "click",
    description: "Click an element by ref, or a point by x and y.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from browser_snapshot." },
        x: { type: "number", description: "Viewport x in CSS pixels." },
        y: { type: "number", description: "Viewport y in CSS pixels." },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button, default left.",
        },
        doubleClick: { type: "boolean", description: "Send a double click instead." },
        modifiers: MODIFIER_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    op: "type",
    description:
      "Type text into the focused element, or into ref when given; set submit to press Enter afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type." },
        ref: { type: "string", description: "Element ref to focus first." },
        submit: { type: "boolean", description: "Press Enter after typing." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_fill",
    op: "fill",
    description: "Replace the value of an input, textarea or select in one step.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from browser_snapshot." },
        value: { type: "string", description: "Value to set." },
      },
      required: ["ref", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_key",
    op: "key",
    description: 'Press a single key such as "Enter", "Escape" or "ArrowDown".',
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name to press." },
        modifiers: MODIFIER_SCHEMA,
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    op: "scroll",
    description: "Scroll the page, or the element at ref or at x and y.",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Scroll direction.",
        },
        amount: { type: "number", description: "Distance in CSS pixels." },
        ref: { type: "string", description: "Element ref to scroll inside." },
        x: { type: "number", description: "Viewport x in CSS pixels." },
        y: { type: "number", description: "Viewport y in CSS pixels." },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    op: "hover",
    description: "Hover an element by ref, or a point by x and y, to reveal menus and tooltips.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from browser_snapshot." },
        x: { type: "number", description: "Viewport x in CSS pixels." },
        y: { type: "number", description: "Viewport y in CSS pixels." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    op: "screenshot",
    description: "Capture the visible page as a PNG image.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_text",
    op: "text",
    description: "Read the page's visible text, main content first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum characters to return." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_console",
    op: "console",
    description: "Read recent console messages from the page.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum messages to return." },
        onlyErrors: { type: "boolean", description: "Keep only errors and warnings." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_network",
    op: "network",
    description: "List recent network requests the page made.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum entries to return." },
        urlPattern: { type: "string", description: "Substring or regex the url must match." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait",
    op: "wait",
    description: "Wait a fixed number of milliseconds, or until a css selector appears.",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "number", description: "Milliseconds to wait." },
        selector: { type: "string", description: "CSS selector to wait for." },
        timeoutMs: { type: "number", description: "Give up on the selector after this long." },
      },
      additionalProperties: false,
    },
  },
  /* The dock: the same socket and the same session, aimed at Chat Hub's own
     right-hand panels instead of at a web page. */
  {
    name: "surface_open",
    op: SURFACE_OPS.open,
    description:
      "Open one of Chat Hub's right-hand panels for this session. Pass \"path\" to land diff on one file, or to reveal a file or folder in files. Changes what the panel shows; never raises or focuses the app window.",
    inputSchema: {
      type: "object",
      properties: {
        surface: {
          type: "string",
          enum: SURFACE_KINDS,
          description: "Which panel to show.",
        },
        path: {
          type: "string",
          description:
            "Project-relative file for diff, or file or folder for files. Rejected for the other surfaces.",
        },
        line: {
          type: "number",
          description: "1-based line to scroll to, files surface only.",
        },
      },
      required: ["surface"],
      additionalProperties: false,
    },
  },
  {
    name: "surface_close",
    op: SURFACE_OPS.close,
    description:
      "Close the right-hand panel again, leaving the chosen surface as it is. Use it to put the window back the way surface_status found it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "surface_status",
    op: SURFACE_OPS.status,
    description:
      "Report which panel this session's dock is on and whether this session is the one on screen — read it before opening something, so the panel can be put back.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "surface_run_script",
    op: SURFACE_OPS.script,
    description:
      "Open the Terminal panel and run one of the project's saved scripts by name. Only scripts the user already saved in .chathub/scripts.json can be run; arbitrary commands cannot.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Name of a saved project script." },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    name: "surface_board_add",
    op: SURFACE_OPS.boardAdd,
    description:
      "Add a todo to the project board (.chathub/board.json) and open the Board panel.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What the todo says." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "surface_board_check",
    op: SURFACE_OPS.boardCheck,
    description:
      'Tick a board todo off, or untick it with done=false, and open the Board panel. Match by the todo\'s exact text, a unique part of it, or its id.',
    inputSchema: {
      type: "object",
      properties: {
        todo: {
          type: "string",
          description: "Todo text, a unique part of it, or its id.",
        },
        done: { type: "boolean", description: "false unticks it; default true." },
      },
      required: ["todo"],
      additionalProperties: false,
    },
  },
]

const POINTER_TOOLS = new Set(["browser_click", "browser_hover"])

function unreachableFor(tool) {
  return tool.op.startsWith(SURFACE_OP_PREFIX)
    ? SURFACE_UNREACHABLE_MESSAGE
    : UNREACHABLE_MESSAGE
}

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
  err.code = "browser-unavailable"
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
    process.stderr.write(`[chathub-browser] unparsable socket line\n`)
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

async function callBrowser(op, params) {
  const open = await ensureSocket()
  const id = randomUUID()
  const request = {
    id,
    sessionId: process.env[BROWSER_SESSION_ENV] ?? "",
    op,
    params,
  }
  const budget = BROWSER_OP_TIMEOUT_MS + TIMEOUT_MARGIN_MS
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
  if (POINTER_TOOLS.has(tool.name)) {
    const hasRef = isPresent(args.ref)
    const hasPoint = typeof args.x === "number" && typeof args.y === "number"
    if (!hasRef && !hasPoint) return `${tool.name} needs a target: ${POINTER_HINT}.`
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

function clamp(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… truncated at ${limit} characters`
}

function pageState(result) {
  const url = typeof result.url === "string" ? result.url : ""
  const title = typeof result.title === "string" ? result.title : ""
  if (!url && !title) return ""
  if (!title) return `url: ${url}`
  return `url: ${url} — title: ${title}`
}

function pickArray(result, keys) {
  for (const key of keys) {
    if (Array.isArray(result[key])) return result[key]
  }
  return null
}

function pickImageData(result) {
  for (const key of ["dataUrl", "data", "base64", "png", "image"]) {
    const value = result[key]
    if (typeof value === "string" && value) {
      return value.replace(/^data:[^;]+;base64,/, "")
    }
  }
  return null
}

function describeConsole(entries) {
  if (entries.length === 0) return "No console messages."
  return entries
    .map((entry) => {
      const level = String(entry.level ?? "log").toUpperCase()
      const where = entry.source ? ` (${entry.source}:${entry.line ?? 0})` : ""
      return `[${level}] ${String(entry.text ?? "")}${where}`
    })
    .join("\n")
}

function describeNetwork(entries) {
  if (entries.length === 0) return "No network requests."
  return entries
    .map((entry) => {
      const status = entry.failed ? "failed" : (entry.status ?? "pending")
      const mime = entry.mimeType ? ` ${entry.mimeType}` : ""
      return `${String(entry.method ?? "GET")} ${String(entry.url ?? "")} → ${status}${mime}`
    })
    .join("\n")
}

function fallbackText(result) {
  if (typeof result.summary === "string" && result.summary) return result.summary
  const state = pageState(result)
  if (state) return `ok — ${state}`
  const keys = Object.keys(result)
  if (keys.length === 0) return "ok"
  return JSON.stringify(result)
}

function shapeResult(tool, result) {
  switch (tool.op) {
    case "snapshot": {
      if (!Array.isArray(result.nodes)) return textResult(fallbackText(result))
      const rendered = renderSnapshot({
        url: typeof result.url === "string" ? result.url : "",
        title: typeof result.title === "string" ? result.title : "",
        nodes: result.nodes,
        truncated: result.truncated === true,
      })
      return textResult(clamp(rendered, BROWSER_SNAPSHOT_CHAR_LIMIT))
    }
    case "screenshot": {
      const data = pickImageData(result)
      if (!data) return errorResult("The browser returned no image data for this screenshot.")
      return {
        content: [
          {
            type: "image",
            data,
            mimeType: typeof result.mimeType === "string" ? result.mimeType : "image/png",
          },
        ],
      }
    }
    case "navigate": {
      const state = pageState(result)
      return textResult(state ? `Navigated — ${state}` : "Navigated.")
    }
    case "click": {
      const state = pageState(result)
      return textResult(state ? `Clicked — ${state}` : "Clicked.")
    }
    case "text": {
      const text = typeof result.text === "string" ? result.text : fallbackText(result)
      return textResult(clamp(text, BROWSER_TEXT_CHAR_LIMIT))
    }
    case "console": {
      const entries = pickArray(result, ["messages", "entries", "console"])
      if (!entries) return textResult(fallbackText(result))
      return textResult(clamp(describeConsole(entries), BROWSER_TEXT_CHAR_LIMIT))
    }
    case "network": {
      const entries = pickArray(result, ["entries", "requests", "network"])
      if (!entries) return textResult(fallbackText(result))
      return textResult(clamp(describeNetwork(entries), BROWSER_TEXT_CHAR_LIMIT))
    }
    default:
      return textResult(fallbackText(result))
  }
}

async function callTool(name, rawArgs) {
  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) return null
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {}
  const invalid = validateArgs(tool, args)
  if (invalid) return errorResult(invalid)

  let response
  try {
    response = await callBrowser(tool.op, buildParams(tool, args))
  } catch (err) {
    if (err && err.code === "browser-unavailable") {
      return errorResult(unreachableFor(tool))
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
  return shapeResult(tool, result)
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
    serverInfo: { name: BROWSER_MCP_SERVER_NAME, version: SERVER_VERSION },
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
        process.stderr.write(`[chathub-browser] dispatch failed: ${String(err)}\n`)
      })
    }
  })
  process.stdin.on("end", () => {
    closeSocket()
    process.exit(0)
  })
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[chathub-browser] ${String(err)}\n`)
  })
}

const entryPath = process.argv[1] ? resolvePath(process.argv[1]) : ""
if (entryPath && entryPath === fileURLToPath(import.meta.url)) main()
