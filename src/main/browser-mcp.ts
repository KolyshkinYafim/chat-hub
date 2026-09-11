import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_SESSION_ENV,
  BROWSER_SOCKET_ENV,
} from "@shared/browser"
import { HUB_MCP_SERVER_NAME } from "@shared/hub-control"
import type { McpProjectConfig, McpServerDef } from "@shared/mcp"
import {
  materializeClaude,
  materializeCodex,
  materializeGrok,
  materializeOpenCode,
  readMcpConfig,
} from "./mcp"

const RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE"

const BROWSER_MCP_SCRIPT = "browser-mcp.mjs"

const MARKER_BLOCK_PROVIDERS = new Set(["codex", "grok"])

type EnvLookup = (serverId: string) => Record<string, string>

export type BrowserMcpLocation = {
  /** Test seam; defaults to the filesystem. */
  exists?: (path: string) => boolean
  packaged: boolean
  resourcesPath: string
  appPath: string
}

export type BrowserMcpSpawn = {
  execPath: string
  scriptPath: string
  socketPath: string
  sessionId: string
}

export type BrowserMcpRegistration = {
  provider: string
  file: string | null
}

export type RegisterBrowserMcpOptions = BrowserMcpSpawn & {
  provider: string
  root: string
  envFor: EnvLookup
}

export type UnregisterBrowserMcpOptions = {
  provider: string
  root: string
  envFor: EnvLookup
}

export function browserMcpServerPath(opts: BrowserMcpLocation): string {
  return mcpScriptPath(opts, BROWSER_MCP_SCRIPT)
}

/**
 * Packaged: the script ships under Resources. Dev: electron-vite sets appPath
 * to the repo root. A build started as `electron out/main/index.js` (the E2E
 * harness, a hand-run of the output) gets appPath = out/main instead, and the
 * repo's resources/ is two levels up — so the MCP servers registered for its
 * agents pointed at a file that did not exist and every tool was unavailable.
 */
export function mcpScriptPath(opts: BrowserMcpLocation, script: string): string {
  if (opts.packaged) return join(opts.resourcesPath, "mcp", script)
  const direct = join(opts.appPath, "resources", "mcp", script)
  if (opts.exists ? opts.exists(direct) : existsSync(direct)) return direct
  const fromBuild = join(opts.appPath, "..", "..", "resources", "mcp", script)
  if (opts.exists ? opts.exists(fromBuild) : existsSync(fromBuild)) return fromBuild
  return direct
}

export function browserMcpEnv(
  opts: Pick<BrowserMcpSpawn, "socketPath" | "sessionId">,
): Record<string, string> {
  const env: Record<string, string> = { [RUN_AS_NODE_ENV]: "1" }
  if (opts.socketPath) env[BROWSER_SOCKET_ENV] = opts.socketPath
  if (opts.sessionId) env[BROWSER_SESSION_ENV] = opts.sessionId
  return env
}

export function browserMcpServerDef(opts: BrowserMcpSpawn): McpServerDef {
  return {
    id: BROWSER_MCP_SERVER_NAME,
    name: BROWSER_MCP_SERVER_NAME,
    enabled: true,
    transport: "stdio",
    command: opts.execPath,
    args: [opts.scriptPath],
    envKeys: Object.keys(browserMcpEnv(opts)),
  }
}

export type BuiltinMcpServer = {
  def: McpServerDef
  env: Record<string, string>
}

export type RegisterBuiltinMcpOptions = {
  provider: string
  root: string
  envFor: EnvLookup
  servers: BuiltinMcpServer[]
}

const BUILTIN_SERVER_NAMES = new Set([
  BROWSER_MCP_SERVER_NAME,
  HUB_MCP_SERVER_NAME,
])

/**
 * Write the browser server into the session provider's own CLI config.
 * Claude and OpenCode merge per server key, so only the hub entry is touched;
 * the TOML providers rewrite one marker block wholesale, so the project's other
 * managed servers have to be re-emitted alongside it or they would vanish.
 */
export async function registerBuiltinMcp(
  opts: RegisterBuiltinMcpOptions,
): Promise<BrowserMcpRegistration> {
  const defs = opts.servers.map((s) => s.def)
  const config = await configForProvider(opts.provider, opts.root, defs)
  const envById = new Map(opts.servers.map((s) => [s.def.id, s.env]))
  const envFor: EnvLookup = (serverId) =>
    envById.get(serverId) ?? opts.envFor(serverId)
  const file = await materializeFor(opts.provider, opts.root, config, envFor, [])
  return { provider: opts.provider, file }
}

export async function registerBrowserMcp(
  opts: RegisterBrowserMcpOptions,
): Promise<BrowserMcpRegistration> {
  return registerBuiltinMcp({
    provider: opts.provider,
    root: opts.root,
    envFor: opts.envFor,
    servers: [{ def: browserMcpServerDef(opts), env: browserMcpEnv(opts) }],
  })
}

export async function unregisterBrowserMcp(
  opts: UnregisterBrowserMcpOptions,
): Promise<BrowserMcpRegistration> {
  const config = await configForProvider(opts.provider, opts.root, [])
  const file = await materializeFor(opts.provider, opts.root, config, opts.envFor, [
    ...BUILTIN_SERVER_NAMES,
  ])
  return { provider: opts.provider, file }
}

async function configForProvider(
  provider: string,
  root: string,
  defs: McpServerDef[],
): Promise<McpProjectConfig> {
  if (!MARKER_BLOCK_PROVIDERS.has(provider)) {
    return { version: 1, servers: defs }
  }
  const base = await readMcpConfig(root)
  const kept = base.servers.filter((s) => !isBuiltinServer(s))
  return { version: 1, servers: [...kept, ...defs] }
}

function isBuiltinServer(s: McpServerDef): boolean {
  return BUILTIN_SERVER_NAMES.has(s.id) || BUILTIN_SERVER_NAMES.has(s.name)
}

async function materializeFor(
  provider: string,
  root: string,
  config: McpProjectConfig,
  envFor: EnvLookup,
  cleanupNames: string[],
): Promise<string | null> {
  switch (provider) {
    case "claude":
      return materializeClaude(root, config, envFor, cleanupNames)
    case "codex":
      return materializeCodex(root, config, envFor)
    case "opencode":
      return materializeOpenCode(root, config, envFor, cleanupNames)
    case "grok":
      return materializeGrok(root, config, envFor)
    default:
      return null
  }
}
