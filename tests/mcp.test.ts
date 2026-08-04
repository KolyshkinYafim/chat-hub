import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  formatMcpArgs,
  parseMcpArgs,
  parseMcpConfig,
  slugifyMcpId,
  type McpServerDef,
} from "@shared/mcp"

const encryption = { available: true }
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    encryptString: (s: string) => Buffer.from(`kc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^kc:/, ""),
  },
}))

const {
  buildCodexBlock,
  materializeClaude,
  materializeCodex,
  materializeMcpForProject,
  materializeOpenCode,
  readMcpConfig,
  removeMcpServer,
  replaceMarkerBlock,
  setMcpServerEnabled,
  upsertMcpServer,
} = await import("../src/main/mcp")
const { SettingsStore } = await import("../src/main/settings")

beforeEach(() => {
  encryption.available = true
})

async function tmpProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chathub-mcp-"))
}

function stdio(
  over: Partial<McpServerDef> & Pick<McpServerDef, "id" | "name">,
): McpServerDef {
  return {
    enabled: true,
    transport: "stdio",
    command: "true",
    args: [],
    envKeys: [],
    ...over,
  }
}

describe("parseMcpConfig / helpers", () => {
  it("accepts a valid config and drops invalid servers", () => {
    const cfg = parseMcpConfig({
      version: 1,
      servers: [
        {
          id: "github",
          name: "github",
          enabled: true,
          transport: "stdio",
          command: "npx",
          args: ["-y", "pkg"],
          envKeys: ["TOKEN"],
        },
        { id: "bad", transport: "stdio" },
        { id: "nope", transport: "fly", command: "x" },
      ],
    })
    expect(cfg.servers).toHaveLength(1)
    expect(cfg.servers[0]!.id).toBe("github")
  })

  it("returns empty on garbage input", () => {
    expect(parseMcpConfig(null).servers).toEqual([])
    expect(parseMcpConfig("nope").servers).toEqual([])
    expect(parseMcpConfig({ servers: "x" }).servers).toEqual([])
  })

  it("rejects stdio without command and http without url", () => {
    expect(
      parseMcpConfig({
        servers: [{ id: "a", name: "a", transport: "stdio", args: [] }],
      }).servers,
    ).toHaveLength(0)
    expect(
      parseMcpConfig({
        servers: [{ id: "b", name: "b", transport: "http", args: [] }],
      }).servers,
    ).toHaveLength(0)
  })

  it("slugifies names and parses args", () => {
    expect(slugifyMcpId("GitHub MCP")).toBe("github-mcp")
    expect(slugifyMcpId("123")).toBe("s-123")
    expect(parseMcpArgs("-y, @pkg extra")).toEqual(["-y", "@pkg", "extra"])
    expect(parseMcpArgs('["-y","@pkg"]')).toEqual(["-y", "@pkg"])
    expect(formatMcpArgs(["a", "b"])).toBe("a b")
  })
})

describe("CRUD", () => {
  it("round-trips upsert → read → remove", async () => {
    const cwd = await tmpProject()
    await upsertMcpServer(
      cwd,
      stdio({ id: "echo", name: "echo", command: "true", args: [] }),
    )
    let cfg = await readMcpConfig(cwd)
    expect(cfg.servers).toHaveLength(1)
    expect(cfg.servers[0]!.command).toBe("true")

    const disk = await readFile(join(cwd, ".chathub", "mcp.json"), "utf8")
    expect(disk).toContain("echo")
    expect(disk).not.toContain("sk-secret")

    await removeMcpServer(cwd, "echo")
    cfg = await readMcpConfig(cwd)
    expect(cfg.servers).toHaveLength(0)
  })
})

describe("materialize", () => {
  it("writes Claude .mcp.json only for enabled servers and keeps foreign ones", async () => {
    const cwd = await tmpProject()
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          foreign: { command: "echo", args: ["hi"] },
        },
      }),
    )
    await upsertMcpServer(
      cwd,
      stdio({ id: "hub1", name: "hub1", command: "true" }),
    )
    await upsertMcpServer(
      cwd,
      stdio({ id: "off", name: "off", command: "false", enabled: false }),
    )

    const cfg = await readMcpConfig(cwd)
    await materializeClaude(cwd, cfg, () => ({}))

    const raw = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>
    }
    expect(raw.mcpServers.foreign).toBeDefined()
    expect(raw.mcpServers.hub1).toMatchObject({ command: "true" })
    expect(raw.mcpServers.off).toBeUndefined()

    // Idempotent
    await materializeClaude(cwd, cfg, () => ({}))
    const raw2 = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(raw2.mcpServers).sort()).toEqual(["foreign", "hub1"])
  })

  it("merges OpenCode without wiping sibling keys", async () => {
    const cwd = await tmpProject()
    await writeFile(
      join(cwd, "opencode.json"),
      JSON.stringify({ theme: "dark", mcp: { keep: { type: "remote", url: "https://x" } } }),
    )
    await upsertMcpServer(
      cwd,
      stdio({ id: "mem", name: "mem", command: "npx", args: ["-y", "pkg"] }),
    )
    const cfg = await readMcpConfig(cwd)
    await materializeOpenCode(cwd, cfg, () => ({}))
    const raw = JSON.parse(await readFile(join(cwd, "opencode.json"), "utf8")) as {
      theme: string
      mcp: Record<string, { type?: string }>
    }
    expect(raw.theme).toBe("dark")
    expect(raw.mcp.keep).toBeDefined()
    expect(raw.mcp.mem?.type).toBe("local")
  })

  it("does not create empty opencode.json when nothing is enabled", async () => {
    const cwd = await tmpProject()
    await upsertMcpServer(
      cwd,
      stdio({ id: "off", name: "off", command: "true", enabled: false }),
    )
    const cfg = await readMcpConfig(cwd)
    const path = await materializeOpenCode(cwd, cfg, () => ({}))
    expect(path).toBeNull()
    await expect(readFile(join(cwd, "opencode.json"), "utf8")).rejects.toThrow()
  })

  it("Codex marker block is idempotent (no duplicate BEGIN/END)", async () => {
    const cwd = await tmpProject()
    await mkdir(join(cwd, ".codex"), { recursive: true })
    await writeFile(
      join(cwd, ".codex", "config.toml"),
      'model = "o3"\n\n# BEGIN CHATHUB-MCP\nold\n# END CHATHUB-MCP\n',
    )
    await upsertMcpServer(
      cwd,
      stdio({ id: "fs", name: "fs", command: "npx", args: ["-y", "fs"] }),
    )
    const cfg = await readMcpConfig(cwd)
    await materializeCodex(cwd, cfg, () => ({}))
    await materializeCodex(cwd, cfg, () => ({}))
    const text = await readFile(join(cwd, ".codex", "config.toml"), "utf8")
    expect(text.match(/# BEGIN CHATHUB-MCP/g)).toHaveLength(1)
    expect(text.match(/# END CHATHUB-MCP/g)).toHaveLength(1)
    expect(text).toContain('model = "o3"')
    expect(text).toContain("[mcp_servers.fs]")
    expect(text).not.toContain("old")
  })

  it("replaceMarkerBlock inserts when markers are missing", () => {
    const next = replaceMarkerBlock("foo = 1\n", buildCodexBlock([], () => ({})))
    expect(next).toContain("foo = 1")
    expect(next).toContain("# BEGIN CHATHUB-MCP")
  })

  it("enabled:false is removed from Claude output after toggle", async () => {
    const cwd = await tmpProject()
    await upsertMcpServer(cwd, stdio({ id: "x", name: "x", command: "true" }))
    let cfg = await readMcpConfig(cwd)
    await materializeClaude(cwd, cfg, () => ({}))
    let raw = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>
    }
    expect(raw.mcpServers.x).toBeDefined()

    await setMcpServerEnabled(cwd, "x", false)
    cfg = await readMcpConfig(cwd)
    await materializeClaude(cwd, cfg, () => ({}))
    raw = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>
    }
    expect(raw.mcpServers.x).toBeUndefined()
  })
})

describe("secrets", () => {
  it("seals env in settings, never writes secrets into .chathub/mcp.json, expands on materialize", async () => {
    const cwd = await tmpProject()
    const settingsPath = join(cwd, "settings.json")
    const settings = new SettingsStore(settingsPath)
    await settings.load()

    await upsertMcpServer(
      cwd,
      stdio({
        id: "gh",
        name: "gh",
        command: "npx",
        args: ["-y", "pkg"],
        envKeys: ["GITHUB_TOKEN"],
      }),
    )
    await settings.setMcpServerEnv("gh", { GITHUB_TOKEN: "sk-secret-token" })

    const keys = settings.getMcpEnvKeys("gh")
    expect(keys).toEqual(["GITHUB_TOKEN"])

    const settingsRaw = await readFile(settingsPath, "utf8")
    expect(settingsRaw).not.toContain("sk-secret-token")
    expect(settingsRaw).toMatch(/enc:v1:|plain:v1:/)

    const projectRaw = await readFile(join(cwd, ".chathub", "mcp.json"), "utf8")
    expect(projectRaw).toContain("GITHUB_TOKEN")
    expect(projectRaw).not.toContain("sk-secret-token")

    await materializeMcpForProject(cwd, (id) => settings.getMcpEnv(id))
    const claude = JSON.parse(
      await readFile(join(cwd, ".mcp.json"), "utf8"),
    ) as { mcpServers: { gh: { env?: { GITHUB_TOKEN?: string } } } }
    expect(claude.mcpServers.gh.env?.GITHUB_TOKEN).toBe("sk-secret-token")

    // empty string deletes
    await settings.setMcpServerEnv("gh", { GITHUB_TOKEN: "" })
    expect(settings.getMcpEnvKeys("gh")).toEqual([])
  })
})
