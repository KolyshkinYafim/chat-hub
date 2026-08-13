/**
 * The contract between the agent-facing MCP server and the Hub's browser
 * surface. One request/response pair per line over a unix socket, so the MCP
 * process stays a thin translator and every capability check lives in main.
 */

export const BROWSER_SOCKET_ENV = "CHATHUB_BROWSER_SOCKET"

export const BROWSER_SESSION_ENV = "CHATHUB_BROWSER_SESSION"

export const BROWSER_SOCKET_BASENAME = "browser.sock"

export const BROWSER_MCP_SERVER_NAME = "chathub-browser"

export const BROWSER_SNAPSHOT_CHAR_LIMIT = 24_000

export const BROWSER_TEXT_CHAR_LIMIT = 24_000

export const BROWSER_SCREENSHOT_MAX_WIDTH = 1400

export const BROWSER_CONSOLE_BUFFER = 200

export const BROWSER_NETWORK_BUFFER = 200

export const BROWSER_OP_TIMEOUT_MS = 30_000

export type BrowserOp =
  | "navigate"
  | "snapshot"
  | "click"
  | "type"
  | "fill"
  | "key"
  | "scroll"
  | "hover"
  | "screenshot"
  | "text"
  | "console"
  | "network"
  | "wait"

export type BrowserRequest = {
  id: string
  sessionId: string
  op: BrowserOp
  params: Record<string, unknown>
}

export type BrowserResponse =
  | { id: string; ok: true; result: Record<string, unknown> }
  | { id: string; ok: false; error: string }

export type BrowserPageState = {
  url: string
  title: string
}

/** One node of the ref-tagged accessibility tree the agent reads and points at. */
export type BrowserNode = {
  ref: string
  role: string
  name: string
  value?: string
  depth: number
  disabled?: boolean
  checked?: boolean
}

export type BrowserSnapshot = BrowserPageState & {
  nodes: BrowserNode[]
  truncated: boolean
}

export type BrowserConsoleMessage = {
  level: "log" | "info" | "warn" | "error" | "debug"
  text: string
  source: string
  line: number
  at: number
}

export type BrowserNetworkEntry = {
  requestId: string
  method: string
  url: string
  status: number | null
  mimeType: string | null
  failed: boolean
  at: number
}

/**
 * The `result` keys each op answers with. The MCP server reimplements its half
 * of this in plain JS, so a rename here is a two-file change by construction.
 */
export type BrowserResultShape = {
  navigate: BrowserPageState
  snapshot: BrowserSnapshot
  click: BrowserPageState
  type: Record<string, never>
  fill: { kind: string }
  key: Record<string, never>
  scroll: Record<string, never>
  hover: Record<string, never>
  screenshot: { dataUrl: string; width: number; height: number }
  text: { text: string; truncated: boolean }
  console: { messages: BrowserConsoleMessage[] }
  network: { requests: BrowserNetworkEntry[] }
  wait: { matched: boolean; selector: string } | { waitedMs: number }
}

export type BrowserActivity = {
  sessionId: string
  op: BrowserOp
  summary: string
  url: string
  at: number
  ok: boolean
}

export type BrowserMouseButton = "left" | "right" | "middle"

export type BrowserScrollDirection = "up" | "down" | "left" | "right"

export const BROWSER_MODIFIERS = ["shift", "control", "alt", "meta"] as const

export type BrowserModifier = (typeof BROWSER_MODIFIERS)[number]

/**
 * A ref is only ever minted by a snapshot, so an agent cannot address an
 * element it has not seen. Refs are invalidated by the next snapshot.
 */
export function isBrowserRef(value: unknown): value is string {
  return typeof value === "string" && /^ref_[1-9][0-9]*$/.test(value)
}

export function renderSnapshot(snapshot: BrowserSnapshot): string {
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
