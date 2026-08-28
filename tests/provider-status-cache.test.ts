import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ProviderStatus } from "../src/shared/settings-types"
import { ProviderStatusCacheStore } from "../src/main/provider-status-cache"

function probedStatus(id: "claude" | "grok"): ProviderStatus {
  return {
    id,
    instanceId: id,
    homeDir: null,
    isExtra: false,
    label: id,
    installed: true,
    binaryPath: `/usr/local/bin/${id}`,
    version: "1.0.0",
    auth: "connected",
    authDetail: "ok",
    models: [{ id: "m1", label: "M1" }],
    defaultModel: "m1",
    loginCommand: null,
    docsUrl: null,
    enabled: true,
    envKeys: [],
    envHints: [],
  }
}

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-status-cache-"))
  const file = join(dir, "provider-status-cache.json")
  const s = new ProviderStatusCacheStore(file)
  await s.load()
  return { s, file, dir }
}

describe("provider status cache store", () => {
  it("has no cached statuses before the first probe", async () => {
    const { s } = await store()
    expect(s.current).toBeNull()
  })

  it("round-trips the last probe through a reload", async () => {
    const { s, file } = await store()
    const cache = { statuses: [probedStatus("claude")], cachedAt: 1234 }
    await s.set(cache)
    const reloaded = new ProviderStatusCacheStore(file)
    await reloaded.load()
    expect(reloaded.current).toEqual(cache)
  })

  it("lives in its own file, not settings.json", async () => {
    const { s, file } = await store()
    await s.set({ statuses: [probedStatus("claude")], cachedAt: 7 })
    const raw = JSON.parse(await readFile(file, "utf8"))
    expect(raw.statuses).toHaveLength(1)
    expect(ProviderStatusCacheStore.defaultPath("/ud")).toBe(
      join("/ud", "data", "provider-status-cache.json"),
    )
  })

  it("drops a malformed cache instead of loading garbage", async () => {
    const { file } = await store()
    await writeFile(
      file,
      JSON.stringify({ statuses: "nope", cachedAt: 5 }),
      "utf8",
    )
    const s = new ProviderStatusCacheStore(file)
    await s.load()
    expect(s.current).toBeNull()
  })

  it("keeps only rows that still look like provider statuses", async () => {
    const { file } = await store()
    await writeFile(
      file,
      JSON.stringify({
        cachedAt: 42,
        statuses: [probedStatus("claude"), { id: "grok" }, null, "x"],
      }),
      "utf8",
    )
    const s = new ProviderStatusCacheStore(file)
    await s.load()
    expect(s.current?.statuses.map((row) => row.id)).toEqual(["claude"])
    expect(s.current?.cachedAt).toBe(42)
  })

  it("requires a finite timestamp before trusting a cache", async () => {
    const { file } = await store()
    await writeFile(
      file,
      JSON.stringify({ statuses: [], cachedAt: "yesterday" }),
      "utf8",
    )
    const s = new ProviderStatusCacheStore(file)
    await s.load()
    expect(s.current).toBeNull()
  })

  it("parks an unparseable file instead of overwriting it", async () => {
    const { file, dir } = await store()
    await writeFile(file, "{not json", "utf8")
    const s = new ProviderStatusCacheStore(file)
    await s.load()
    expect(s.current).toBeNull()
    const entries = await readdir(dir)
    expect(
      entries.some((name) => name.startsWith("provider-status-cache.json.corrupt-")),
    ).toBe(true)
    await s.set({ statuses: [], cachedAt: 9 })
    const parked = entries.find((name) => name.includes("corrupt"))
    expect(await readFile(join(dir, parked!), "utf8")).toBe("{not json")
  })
})
