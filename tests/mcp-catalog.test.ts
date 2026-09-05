import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { assertMcpServerDef, isValidMcpId, parseMcpConfig } from "@shared/mcp"
import {
  MCP_CATALOG,
  mcpPresetByUrl,
  mcpPresetToServerDef,
  mcpUnreachableDetail,
} from "@shared/mcp-catalog"

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`kc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^kc:/, ""),
  },
}))

const { materializeMcpForProject, upsertMcpServer } = await import(
  "../src/main/mcp"
)
const { SettingsStore } = await import("../src/main/settings")

function preset(id: string) {
  const found = MCP_CATALOG.find((p) => p.id === id)
  if (!found) throw new Error(`missing preset ${id}`)
  return found
}

describe("catalog shape", () => {
  it("has unique valid ids", () => {
    const ids = MCP_CATALOG.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isValidMcpId(id)).toBe(true)
  })

  it("http presets carry a url, stdio presets a command", () => {
    for (const p of MCP_CATALOG) {
      if (p.transport === "http") {
        expect(p.url).toMatch(/^https?:\/\//)
        expect(p.command).toBeUndefined()
      } else {
        expect(p.command).toBeTruthy()
        expect(p.url).toBeUndefined()
      }
      expect(p.docsUrl).toMatch(/^https:\/\//)
      expect(p.note.length).toBeGreaterThan(0)
    }
  })

  it("every preset converts to a valid server def that survives config parsing", () => {
    for (const p of MCP_CATALOG) {
      const def = mcpPresetToServerDef(p)
      expect(() => assertMcpServerDef(def)).not.toThrow()
      const parsed = parseMcpConfig({ version: 1, servers: [def] })
      expect(parsed.servers).toHaveLength(1)
      expect(parsed.servers[0]).toEqual(def)
    }
  })

  it("token presets name their env keys, oauth and local ones none", () => {
    for (const p of MCP_CATALOG) {
      if (p.auth === "token") expect(p.envKeys.length).toBeGreaterThan(0)
      else expect(p.envKeys).toEqual([])
    }
  })
})

describe("preset conversion", () => {
  it("maps a remote preset to an enabled http def", () => {
    expect(mcpPresetToServerDef(preset("sentry"))).toEqual({
      id: "sentry",
      name: "sentry",
      enabled: true,
      transport: "http",
      args: [],
      envKeys: [],
      url: "https://mcp.sentry.dev/mcp",
    })
  })

  it("maps a stdio preset with its args and env key names", () => {
    const def = mcpPresetToServerDef(preset("figma-framelink"))
    expect(def.transport).toBe("stdio")
    expect(def.command).toBe("npx")
    expect(def.args).toEqual(["-y", "figma-developer-mcp", "--stdio"])
    expect(def.envKeys).toEqual(["FIGMA_API_KEY"])
    expect(def.url).toBeUndefined()
  })

  it("copies arrays so editing the def cannot mutate the catalog", () => {
    const def = mcpPresetToServerDef(preset("context7"))
    def.args.push("--extra")
    def.envKeys.push("X")
    expect(preset("context7").args).not.toContain("--extra")
    expect(preset("context7").envKeys).not.toContain("X")
  })

  it("knows the figma desktop offline wording by url", () => {
    expect(mcpPresetByUrl("http://127.0.0.1:3845/mcp")?.id).toBe("figma-desktop")
    expect(mcpUnreachableDetail("http://127.0.0.1:3845/mcp")).toBe(
      "Figma desktop not running",
    )
    expect(mcpUnreachableDetail("https://mcp.sentry.dev/mcp")).toBe("Unreachable")
    expect(mcpUnreachableDetail(undefined)).toBe("Unreachable")
  })
})

describe("catalog presets materialize into native CLI configs", () => {
  it("writes sentry, clickup and github as remote entries without secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chathub-mcp-catalog-"))
    const settings = new SettingsStore(join(cwd, "settings.json"))
    await settings.load()
    for (const id of ["sentry", "clickup", "github"]) {
      await upsertMcpServer(cwd, mcpPresetToServerDef(preset(id)))
    }
    await upsertMcpServer(cwd, mcpPresetToServerDef(preset("figma-framelink")))
    await settings.setMcpServerEnv("figma-framelink", {
      FIGMA_API_KEY: "figd-secret-value",
    })

    const res = await materializeMcpForProject(cwd, (id) =>
      settings.getMcpEnv(id),
    )
    expect(res.ok).toBe(true)

    const claude = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { url?: string; command?: string; env?: Record<string, string> }>
    }
    expect(claude.mcpServers.sentry).toEqual({ url: "https://mcp.sentry.dev/mcp" })
    expect(claude.mcpServers.clickup).toEqual({ url: "https://mcp.clickup.com/mcp" })
    expect(claude.mcpServers.github).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
    })
    expect(claude.mcpServers["figma-framelink"]?.env?.FIGMA_API_KEY).toBe(
      "figd-secret-value",
    )

    const opencode = JSON.parse(
      await readFile(join(cwd, "opencode.json"), "utf8"),
    ) as { mcp: Record<string, { type: string; url?: string; enabled: boolean }> }
    expect(opencode.mcp.sentry).toEqual({
      type: "remote",
      enabled: true,
      url: "https://mcp.sentry.dev/mcp",
    })
    expect(opencode.mcp.clickup?.type).toBe("remote")
    expect(opencode.mcp.github?.url).toBe("https://api.githubcopilot.com/mcp/")

    const project = await readFile(join(cwd, ".chathub", "mcp.json"), "utf8")
    expect(project).toContain("FIGMA_API_KEY")
    expect(project).not.toContain("figd-secret-value")
  })
})
