/** Project-local MCP server definitions (no secret values). */

export type McpTransport = "stdio" | "http"

export type McpServerDef = {
  /** Stable slug, unique in the project file. */
  id: string
  /** Display name and key in native CLI configs (usually equals id). */
  name: string
  enabled: boolean
  transport: McpTransport
  /** Required for stdio. */
  command?: string
  args: string[]
  /** Env var *names* only — values live sealed in user settings. */
  envKeys: string[]
  /** Required for http. */
  url?: string
}

export type McpProjectConfig = {
  version: 1
  servers: McpServerDef[]
}

export type McpStatusState = "unknown" | "ok" | "error" | "disabled"

export type McpServerStatus = {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  state: McpStatusState
  detail?: string
  checkedAt?: number
}

/** Empty string values delete the key (same contract as provider env). */
export type McpSecretPatch = {
  serverId: string
  env: Record<string, string>
}

export type McpListResult = {
  config: McpProjectConfig
  statuses: McpServerStatus[]
  /** serverId → env key names that have a sealed value in user settings. */
  envKeysByServer: Record<string, string[]>
}

export type McpMaterializeResult = {
  ok: boolean
  written: string[]
  error?: string
}

export const MCP_REL_PATH = ".chathub/mcp.json"

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/

/** Turn a display name into a stable id slug. */
export function slugifyMcpId(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
  if (!s) return "server"
  if (/^[0-9]/.test(s)) return `s-${s}`
  return s.slice(0, 64)
}

/**
 * Parse a command-args field from the UI.
 * Prefer JSON array when the value looks like one; otherwise split on
 * whitespace (shell-ish, no quotes). Commas are treated as separators too.
 */
export function parseMcpArgs(raw: string): string[] {
  const text = raw.trim()
  if (!text) return []
  if (text.startsWith("[")) {
    try {
      const v: unknown = JSON.parse(text)
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        return v.map((s) => s.trim()).filter(Boolean)
      }
    } catch {
      /* fall through */
    }
  }
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function formatMcpArgs(args: string[]): string {
  return args.join(" ")
}

export function isValidMcpId(id: string): boolean {
  return ID_RE.test(id)
}

/**
 * Coerce unknown JSON into a project config.
 * Drop invalid servers rather than rejecting the whole file — the file is
 * hand-editable and a single bad entry should not blank the rest.
 */
export function parseMcpConfig(raw: unknown): McpProjectConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyMcpConfig()
  }
  const o = raw as Record<string, unknown>
  const list = Array.isArray(o.servers) ? o.servers : []
  const servers: McpServerDef[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const def = coerceServer(item)
    if (!def) continue
    if (seen.has(def.id)) continue
    seen.add(def.id)
    servers.push(def)
  }
  return { version: 1, servers }
}

export function emptyMcpConfig(): McpProjectConfig {
  return { version: 1, servers: [] }
}

function coerceServer(raw: unknown): McpServerDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const idRaw = typeof o.id === "string" ? o.id.trim() : ""
  const nameRaw = typeof o.name === "string" ? o.name.trim() : idRaw
  const id = isValidMcpId(idRaw) ? idRaw : slugifyMcpId(idRaw || nameRaw)
  if (!isValidMcpId(id)) return null
  const name = nameRaw || id
  const transport = o.transport === "http" ? "http" : o.transport === "stdio" ? "stdio" : null
  if (!transport) return null

  const enabled = o.enabled !== false
  const args = Array.isArray(o.args)
    ? o.args.filter((a): a is string => typeof a === "string").map((a) => a.trim())
    : []
  const envKeys = Array.isArray(o.envKeys)
    ? o.envKeys
        .filter((k): k is string => typeof k === "string")
        .map((k) => k.trim())
        .filter(Boolean)
    : []

  if (transport === "stdio") {
    const command = typeof o.command === "string" ? o.command.trim() : ""
    if (!command) return null
    return {
      id,
      name,
      enabled,
      transport,
      command,
      args,
      envKeys,
    }
  }

  const url = typeof o.url === "string" ? o.url.trim() : ""
  if (!url || !/^https?:\/\//i.test(url)) return null
  return {
    id,
    name,
    enabled,
    transport,
    args: [],
    envKeys,
    url,
  }
}

/** Validate a def before write; throws Error with a short message. */
export function assertMcpServerDef(def: McpServerDef): void {
  if (!isValidMcpId(def.id)) throw new Error(`Invalid MCP server id: ${def.id}`)
  if (!def.name.trim()) throw new Error("MCP server name required")
  if (def.transport !== "stdio" && def.transport !== "http") {
    throw new Error(`Unknown MCP transport: ${String(def.transport)}`)
  }
  if (def.transport === "stdio") {
    if (!def.command?.trim()) throw new Error("stdio MCP server needs a command")
  } else if (!def.url?.trim() || !/^https?:\/\//i.test(def.url)) {
    throw new Error("http MCP server needs an http(s) url")
  }
}
