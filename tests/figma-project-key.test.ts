import { describe, expect, it, vi } from "vitest"
import type { McpProjectConfig, McpServerDef } from "@shared/mcp"
import { figmaKeyForProject } from "../src/main/figma-project-key"

const server = (overrides: Partial<McpServerDef> = {}): McpServerDef => ({
  id: "figma-framelink", name: "Figma", enabled: true, transport: "stdio", command: "figma-mcp", args: [], envKeys: ["FIGMA_API_KEY"], ...overrides,
})
const config = (servers: McpServerDef[]): McpProjectConfig => ({ version: 1, servers })

describe("Figma worktree keys", () => {
  it("inherits the base project when a worktree has no Figma configuration", async () => {
    const read = vi.fn(async (cwd: string) => config(cwd === "/project" ? [server()] : [server({ id: "other-mcp", envKeys: [] })]))
    const env = vi.fn(() => ({ FIGMA_API_KEY: "base-key" }))
    expect(await figmaKeyForProject("/worktree", "/project", read, env)).toBe("base-key")
    expect(read.mock.calls).toEqual([["/worktree"], ["/project"]])
  })
  it.each([
    server({ enabled: false }),
    server({ id: "figma-desktop", transport: "http", envKeys: [] }),
    server({ id: "custom-figma", enabled: false }),
  ])("respects an explicit local override %j", async (local) => {
    const read = vi.fn(async () => config([local]))
    const env = vi.fn(() => ({ FIGMA_API_KEY: "base-key" }))
    expect(await figmaKeyForProject("/worktree", "/project", read, env)).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
    expect(env).not.toHaveBeenCalled()
  })
  it("uses a local key and never consults the base project", async () => {
    const read = vi.fn(async () => config([server({ id: "local-figma" })]))
    expect(await figmaKeyForProject("/worktree", "/project", read, () => ({ FIGMA_API_KEY: "local-key" }))).toBe("local-key")
    expect(read).toHaveBeenCalledTimes(1)
  })
  it("does not bypass a local server whose key is missing", async () => {
    const read = vi.fn(async () => config([server()]))
    expect(await figmaKeyForProject("/worktree", "/project", read, () => ({}))).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, "/project"])("does not infer a base project for %s", async (base) => {
    const read = vi.fn(async () => config([]))
    expect(await figmaKeyForProject("/project", base, read, () => ({}))).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
  })
})
