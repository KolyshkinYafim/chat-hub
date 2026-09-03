import { join } from "node:path"
import { HUB_MCP_SERVER_NAME } from "@shared/hub-control"
import type { McpServerDef } from "@shared/mcp"
import {
  browserMcpEnv,
  type BrowserMcpLocation,
  type BrowserMcpSpawn,
} from "./browser-mcp"

const HUB_MCP_SCRIPT = "hub-mcp.mjs"

export function hubMcpServerPath(opts: BrowserMcpLocation): string {
  return opts.packaged
    ? join(opts.resourcesPath, "mcp", HUB_MCP_SCRIPT)
    : join(opts.appPath, "resources", "mcp", HUB_MCP_SCRIPT)
}

export function hubMcpEnv(
  opts: Pick<BrowserMcpSpawn, "socketPath" | "sessionId">,
): Record<string, string> {
  return browserMcpEnv(opts)
}

export function hubMcpServerDef(opts: BrowserMcpSpawn): McpServerDef {
  return {
    id: HUB_MCP_SERVER_NAME,
    name: HUB_MCP_SERVER_NAME,
    enabled: true,
    transport: "stdio",
    command: opts.execPath,
    args: [opts.scriptPath],
    envKeys: Object.keys(hubMcpEnv(opts)),
  }
}
