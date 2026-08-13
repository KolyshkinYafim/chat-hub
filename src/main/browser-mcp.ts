import { join } from "node:path"
import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_SESSION_ENV,
  BROWSER_SOCKET_ENV,
} from "@shared/browser"
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
  return opts.packaged
    ? join(opts.resourcesPath, "mcp", BROWSER_MCP_SCRIPT)
    : join(opts.appPath, "resources", "mcp", BROWSER_MCP_SCRIPT)
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

/**
 * Write the browser server into the session provider's own CLI config.
 * Claude and OpenCode merge per server key, so only the hub entry is touched;
 * the TOML providers rewrite one marker block wholesale, so the project's other
 * managed servers have to be re-emitted alongside it or they would vanish.
 */
export async function registerBrowserMcp(
  opts: RegisterBrowserMcpOptions,
): Promise<BrowserMcpRegistration> {
  const def = browserMcpServerDef(opts)
  const config = await configForProvider(opts.provider, opts.root, def)
  const env = browserMcpEnv(opts)
  const envFor: EnvLookup = (serverId) =>
    serverId === def.id ? env : opts.envFor(serverId)
  const file = await materializeFor(opts.provider, opts.root, config, envFor, [])
  return { provider: opts.provider, file }
}

export async function unregisterBrowserMcp(
  opts: UnregisterBrowserMcpOptions,
): Promise<BrowserMcpRegistration> {
  const config = await configForProvider(opts.provider, opts.root, null)
  const file = await materializeFor(opts.provider, opts.root, config, opts.envFor, [
    BROWSER_MCP_SERVER_NAME,
  ])
  return { provider: opts.provider, file }
}

async function configForProvider(
  provider: string,
  root: string,
  def: McpServerDef | null,
): Promise<McpProjectConfig> {
  if (!MARKER_BLOCK_PROVIDERS.has(provider)) {
    return { version: 1, servers: def ? [def] : [] }
  }
  const base = await readMcpConfig(root)
  const kept = base.servers.filter((s) => !isBrowserServer(s))
  return { version: 1, servers: def ? [...kept, def] : kept }
}

function isBrowserServer(s: McpServerDef): boolean {
  return s.id === BROWSER_MCP_SERVER_NAME || s.name === BROWSER_MCP_SERVER_NAME
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
