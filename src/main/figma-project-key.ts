import type { McpProjectConfig, McpServerDef } from "@shared/mcp"

function isFigmaServer(server: McpServerDef): boolean {
  return server.envKeys.includes("FIGMA_API_KEY") || /^figma(?:-|$)/.test(server.id)
}

export async function figmaKeyForProject(
  cwd: string,
  baseCwd: string | undefined,
  readConfig: (cwd: string) => Promise<McpProjectConfig>,
  envFor: (serverId: string) => Record<string, string>,
): Promise<string | null> {
  const local = (await readConfig(cwd)).servers.filter(isFigmaServer)
  const servers = local.length || !baseCwd || baseCwd === cwd
    ? local
    : (await readConfig(baseCwd)).servers.filter(isFigmaServer)
  for (const server of servers) {
    if (!server.enabled || !server.envKeys.includes("FIGMA_API_KEY")) continue
    const key = envFor(server.id).FIGMA_API_KEY
    if (key) return key
  }
  return null
}
