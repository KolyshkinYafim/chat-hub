import type { McpServerDef, McpTransport } from "./mcp"

export type McpPresetAuth = "oauth" | "token" | "none"

export type McpPreset = {
  id: string
  name: string
  transport: McpTransport
  url?: string
  command?: string
  args: string[]
  envKeys: string[]
  docsUrl: string
  auth: McpPresetAuth
  note: string
  offlineDetail?: string
}

export const MCP_CATALOG: readonly McpPreset[] = [
  {
    id: "github",
    name: "github",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    args: [],
    envKeys: [],
    docsUrl: "https://github.com/github/github-mcp-server",
    auth: "oauth",
    note: "Issues, pull requests, code search and Actions on GitHub.",
  },
  {
    id: "sentry",
    name: "sentry",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    args: [],
    envKeys: [],
    docsUrl: "https://mcp.sentry.dev/",
    auth: "oauth",
    note: "Errors, issues and traces from your Sentry organization.",
  },
  {
    id: "clickup",
    name: "clickup",
    transport: "http",
    url: "https://mcp.clickup.com/mcp",
    args: [],
    envKeys: [],
    docsUrl:
      "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    auth: "oauth",
    note: "Tasks, docs, comments and time tracking in ClickUp.",
  },
  {
    id: "figma-desktop",
    name: "figma-desktop",
    transport: "http",
    url: "http://127.0.0.1:3845/mcp",
    args: [],
    envKeys: [],
    docsUrl:
      "https://developers.figma.com/docs/figma-mcp-server/local-server-installation/",
    auth: "none",
    note: "Dev Mode server inside the Figma desktop app; needs the app running.",
    offlineDetail: "Figma desktop not running",
  },
  {
    id: "figma-framelink",
    name: "figma-framelink",
    transport: "stdio",
    command: "npx",
    args: ["-y", "figma-developer-mcp", "--stdio"],
    envKeys: ["FIGMA_API_KEY"],
    docsUrl: "https://github.com/GLips/Figma-Context-MCP",
    auth: "token",
    note: "Reads Figma files through the REST API with a personal token.",
  },
  {
    id: "context7",
    name: "context7",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    envKeys: ["CONTEXT7_API_KEY"],
    docsUrl: "https://github.com/upstash/context7",
    auth: "token",
    note: "Up-to-date library docs and code examples; a key lifts rate limits.",
  },
  {
    id: "langfuse-docs",
    name: "langfuse-docs",
    transport: "http",
    url: "https://langfuse.com/api/mcp",
    args: [],
    envKeys: [],
    docsUrl: "https://langfuse.com/docs/docs-mcp",
    auth: "none",
    note: "Searches the Langfuse documentation.",
  },
  {
    id: "linear",
    name: "linear",
    transport: "http",
    url: "https://mcp.linear.app/mcp",
    args: [],
    envKeys: [],
    docsUrl: "https://linear.app/docs/mcp",
    auth: "oauth",
    note: "Issues, projects and cycles in Linear.",
  },
  {
    id: "atlassian",
    name: "atlassian",
    transport: "http",
    url: "https://mcp.atlassian.com/v2/mcp",
    args: [],
    envKeys: [],
    docsUrl:
      "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    auth: "oauth",
    note: "Jira, Confluence and Bitbucket through Atlassian Rovo.",
  },
]

export function mcpPresetToServerDef(preset: McpPreset): McpServerDef {
  const def: McpServerDef = {
    id: preset.id,
    name: preset.name,
    enabled: true,
    transport: preset.transport,
    args: preset.transport === "stdio" ? [...preset.args] : [],
    envKeys: [...preset.envKeys],
  }
  if (preset.transport === "stdio") def.command = preset.command
  else def.url = preset.url
  return def
}

export function mcpPresetByUrl(url: string | undefined): McpPreset | undefined {
  if (!url) return undefined
  return MCP_CATALOG.find((p) => p.url === url)
}

export function mcpUnreachableDetail(url: string | undefined): string {
  return mcpPresetByUrl(url)?.offlineDetail ?? "Unreachable"
}
