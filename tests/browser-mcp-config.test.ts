import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_SESSION_ENV,
  BROWSER_SOCKET_ENV,
} from "@shared/browser"
import type { McpServerDef } from "@shared/mcp"
import {
  browserMcpEnv,
  browserMcpServerDef,
  browserMcpServerPath,
  registerBrowserMcp,
  unregisterBrowserMcp,
} from "../src/main/browser-mcp"
import { materializeGrok, readMcpConfig, upsertMcpServer } from "../src/main/mcp"

const EXEC_PATH = "/Applications/Chat Hub.app/Contents/MacOS/Chat Hub"
const SCRIPT_PATH = "/Applications/Chat Hub.app/Contents/Resources/mcp/browser-mcp.mjs"
const SOCKET_PATH = "/tmp/chathub/browser.sock"
const SESSION_ID = "session-42"

const noEnv = () => ({})

function spawnOpts() {
  return {
    execPath: EXEC_PATH,
    scriptPath: SCRIPT_PATH,
    socketPath: SOCKET_PATH,
    sessionId: SESSION_ID,
  }
}

async function tmpProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chathub-browser-mcp-"))
}

async function readJson(file: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, any>
}

async function register(root: string, provider: string) {
  return registerBrowserMcp({ ...spawnOpts(), provider, root, envFor: noEnv })
}

describe("browserMcpServerPath", () => {
  it("points inside Resources when packaged and at the repo copy in dev", () => {
    expect(
      browserMcpServerPath({
        packaged: true,
        resourcesPath: "/Applications/Chat Hub.app/Contents/Resources",
        appPath: "/Applications/Chat Hub.app/Contents/Resources/app.asar",
      }),
    ).toBe("/Applications/Chat Hub.app/Contents/Resources/mcp/browser-mcp.mjs")

    expect(
      browserMcpServerPath({
        packaged: false,
        resourcesPath: "/unused",
        appPath: "/repo/chat-hub",
      }),
    ).toBe("/repo/chat-hub/resources/mcp/browser-mcp.mjs")
  })
})

describe("browserMcpServerDef", () => {
  it("describes a stdio server running the script under Electron's node mode", () => {
    const def: McpServerDef = browserMcpServerDef(spawnOpts())
    expect(def).toEqual({
      id: BROWSER_MCP_SERVER_NAME,
      name: BROWSER_MCP_SERVER_NAME,
      enabled: true,
      transport: "stdio",
      command: EXEC_PATH,
      args: [SCRIPT_PATH],
      envKeys: ["ELECTRON_RUN_AS_NODE", BROWSER_SOCKET_ENV, BROWSER_SESSION_ENV],
    })
    expect(browserMcpEnv(spawnOpts())).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      [BROWSER_SOCKET_ENV]: SOCKET_PATH,
      [BROWSER_SESSION_ENV]: SESSION_ID,
    })
  })
})

describe("registerBrowserMcp", () => {
  it("writes the Claude entry and leaves a foreign server and its secrets alone", async () => {
    const root = await tmpProject()
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { foreign: { command: "npx", env: { TOKEN: "sk-foreign" } } },
      }),
    )

    const res = await register(root, "claude")
    expect(res).toEqual({ provider: "claude", file: join(root, ".mcp.json") })

    const raw = await readJson(join(root, ".mcp.json"))
    expect(raw.mcpServers.foreign).toEqual({ command: "npx", env: { TOKEN: "sk-foreign" } })
    expect(raw.mcpServers[BROWSER_MCP_SERVER_NAME]).toEqual({
      command: EXEC_PATH,
      args: [SCRIPT_PATH],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        [BROWSER_SOCKET_ENV]: SOCKET_PATH,
        [BROWSER_SESSION_ENV]: SESSION_ID,
      },
    })
  })

  it("writes the Codex marker block without disturbing the rest of the TOML", async () => {
    const root = await tmpProject()
    await mkdir(join(root, ".codex"), { recursive: true })
    await writeFile(
      join(root, ".codex", "config.toml"),
      'model = "o3"\n\n[mcp_servers.foreign]\ncommand = "npx"\n',
    )

    const res = await register(root, "codex")
    expect(res.file).toBe(join(root, ".codex", "config.toml"))

    const text = await readFile(join(root, ".codex", "config.toml"), "utf8")
    expect(text).toContain('model = "o3"')
    expect(text).toContain("[mcp_servers.foreign]")
    expect(text).toContain(`[mcp_servers."${BROWSER_MCP_SERVER_NAME}"]`)
    expect(text).toContain(`command = "${EXEC_PATH}"`)
    expect(text).toContain(`${BROWSER_SOCKET_ENV} = "${SOCKET_PATH}"`)
    expect(text).not.toContain("enabled = true")
  })

  it("writes the OpenCode entry and keeps sibling keys", async () => {
    const root = await tmpProject()
    await writeFile(
      join(root, "opencode.json"),
      JSON.stringify({ theme: "dark", mcp: { keep: { type: "remote", url: "https://x" } } }),
    )

    const res = await register(root, "opencode")
    expect(res.file).toBe(join(root, "opencode.json"))

    const raw = await readJson(join(root, "opencode.json"))
    expect(raw.theme).toBe("dark")
    expect(raw.mcp.keep).toEqual({ type: "remote", url: "https://x" })
    expect(raw.mcp[BROWSER_MCP_SERVER_NAME]).toEqual({
      type: "local",
      enabled: true,
      command: [EXEC_PATH, SCRIPT_PATH],
      environment: {
        ELECTRON_RUN_AS_NODE: "1",
        [BROWSER_SOCKET_ENV]: SOCKET_PATH,
        [BROWSER_SESSION_ENV]: SESSION_ID,
      },
    })
  })

  it("writes the Grok config with the enabled flag grok's own CLI emits", async () => {
    const root = await tmpProject()
    await mkdir(join(root, ".grok"), { recursive: true })
    await writeFile(
      join(root, ".grok", "config.toml"),
      '[mcp_servers.foreign]\ncommand = "/bin/echo"\nenabled = true\n',
    )

    const res = await register(root, "grok")
    expect(res.file).toBe(join(root, ".grok", "config.toml"))

    const text = await readFile(join(root, ".grok", "config.toml"), "utf8")
    expect(text).toContain("[mcp_servers.foreign]")
    expect(text).toContain(`[mcp_servers."${BROWSER_MCP_SERVER_NAME}"]`)
    expect(text).toContain("enabled = true")
    expect(text).toContain(`[mcp_servers."${BROWSER_MCP_SERVER_NAME}".env]`)
    expect(text).toContain(`${BROWSER_SESSION_ENV} = "${SESSION_ID}"`)
  })

  it("re-emits the project's own managed servers into the rewritten TOML block", async () => {
    const root = await tmpProject()
    await upsertMcpServer(root, {
      id: "fs",
      name: "fs",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "fs"],
      envKeys: ["FS_TOKEN"],
    })

    await registerBrowserMcp({
      ...spawnOpts(),
      provider: "grok",
      root,
      envFor: (id) => (id === "fs" ? { FS_TOKEN: "sk-fs" } : {}),
    })

    const text = await readFile(join(root, ".grok", "config.toml"), "utf8")
    expect(text).toContain("[mcp_servers.fs]")
    expect(text).toContain('FS_TOKEN = "sk-fs"')
    expect(text).toContain(`[mcp_servers."${BROWSER_MCP_SERVER_NAME}"]`)
  })

  it("does not add the browser server to the project's own canon", async () => {
    const root = await tmpProject()
    await register(root, "claude")
    expect((await readMcpConfig(root)).servers).toHaveLength(0)
  })

  it("writes nothing for a provider with no MCP config of its own", async () => {
    const root = await tmpProject()
    expect(await register(root, "mock")).toEqual({ provider: "mock", file: null })
    await expect(readFile(join(root, ".mcp.json"), "utf8")).rejects.toThrow()
  })

  it("replaces its own block on a second write instead of stacking markers", async () => {
    const root = await tmpProject()
    await mkdir(join(root, ".grok"), { recursive: true })
    await writeFile(join(root, ".grok", "config.toml"), 'model = "grok-4"\n')

    await register(root, "grok")
    await registerBrowserMcp({
      ...spawnOpts(),
      provider: "grok",
      root,
      socketPath: "/tmp/chathub/second.sock",
      envFor: noEnv,
    })

    const text = await readFile(join(root, ".grok", "config.toml"), "utf8")
    expect(text.match(/# BEGIN CHATHUB-MCP/g)).toHaveLength(1)
    expect(text.match(/# END CHATHUB-MCP/g)).toHaveLength(1)
    expect(text.match(/\[mcp_servers\."chathub-browser"\]/g)).toHaveLength(1)
    expect(text).toContain('model = "grok-4"')
    expect(text).toContain('/tmp/chathub/second.sock')
    expect(text).not.toContain(SOCKET_PATH)
  })
})

describe("unregisterBrowserMcp", () => {
  it("removes only the hub entry from Claude and OpenCode", async () => {
    const root = await tmpProject()
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { foreign: { command: "npx" } } }),
    )
    await writeFile(join(root, "opencode.json"), JSON.stringify({ theme: "dark" }))

    await register(root, "claude")
    await register(root, "opencode")
    await unregisterBrowserMcp({ provider: "claude", root, envFor: noEnv })
    await unregisterBrowserMcp({ provider: "opencode", root, envFor: noEnv })

    const claude = await readJson(join(root, ".mcp.json"))
    const opencode = await readJson(join(root, "opencode.json"))
    expect(claude.mcpServers.foreign).toBeDefined()
    expect(claude.mcpServers[BROWSER_MCP_SERVER_NAME]).toBeUndefined()
    expect(opencode.theme).toBe("dark")
    expect(opencode.mcp[BROWSER_MCP_SERVER_NAME]).toBeUndefined()
  })

  it("drops the entry from the TOML block and keeps foreign tables and project servers", async () => {
    const root = await tmpProject()
    await mkdir(join(root, ".grok"), { recursive: true })
    await writeFile(
      join(root, ".grok", "config.toml"),
      '[mcp_servers.foreign]\ncommand = "/bin/echo"\n',
    )
    await upsertMcpServer(root, {
      id: "fs",
      name: "fs",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "fs"],
      envKeys: [],
    })

    await register(root, "grok")
    await unregisterBrowserMcp({ provider: "grok", root, envFor: noEnv })

    const text = await readFile(join(root, ".grok", "config.toml"), "utf8")
    expect(text).toContain("[mcp_servers.foreign]")
    expect(text).toContain("[mcp_servers.fs]")
    expect(text).not.toContain("chathub-browser")
  })
})

describe("materializeGrok", () => {
  it("leaves the TOML around its block untouched across rewrites", async () => {
    const root = await tmpProject()
    await mkdir(join(root, ".grok"), { recursive: true })
    await writeFile(
      join(root, ".grok", "config.toml"),
      'model = "grok-4"\n\n# BEGIN CHATHUB-MCP\nstale\n# END CHATHUB-MCP\n\n[ui]\nyolo = false\n',
    )
    const config = {
      version: 1 as const,
      servers: [
        {
          id: "one",
          name: "one",
          enabled: true,
          transport: "stdio" as const,
          command: "npx",
          args: ["-y", "one"],
          envKeys: [],
        },
      ],
    }

    await materializeGrok(root, config, noEnv)
    await materializeGrok(root, config, noEnv)

    const text = await readFile(join(root, ".grok", "config.toml"), "utf8")
    expect(text.match(/# BEGIN CHATHUB-MCP/g)).toHaveLength(1)
    expect(text).toContain('model = "grok-4"')
    expect(text).toContain("[ui]")
    expect(text).toContain("yolo = false")
    expect(text).toContain("[mcp_servers.one]")
    expect(text).toContain('args = ["-y", "one"]')
    expect(text).not.toContain("stale")
  })
})
