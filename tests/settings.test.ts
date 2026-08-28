import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

// safeStorage only exists inside a running Electron main process. Stand in a
// reversible fake so seal/open round-trips exercise the encrypted branch.
const encryption = { available: true }
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    encryptString: (s: string) => Buffer.from(`kc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^kc:/, ""),
  },
}))

const { SettingsStore, sanitizeGeneralPatch } = await import("../src/main/settings")
const { openSecret, sealSecret } = await import("../src/main/secret")

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-settings-"))
  const file = join(dir, "settings.json")
  const s = new SettingsStore(file)
  await s.load()
  return { s, file }
}

beforeEach(() => {
  encryption.available = true
})

describe("secret sealing", () => {
  it("round-trips through the keychain branch", () => {
    const sealed = sealSecret("sk-ant-123")
    expect(sealed.startsWith("enc:v1:")).toBe(true)
    expect(sealed).not.toContain("sk-ant-123")
    expect(openSecret(sealed)).toBe("sk-ant-123")
  })

  it("falls back to tagged plaintext when the keychain is unavailable", () => {
    encryption.available = false
    const sealed = sealSecret("sk-ant-123")
    expect(sealed.startsWith("plain:v1:")).toBe(true)
    expect(openSecret(sealed)).toBe("sk-ant-123")
  })

  it("returns empty rather than throwing when an encrypted value cannot be opened", () => {
    const sealed = sealSecret("sk-ant-123")
    encryption.available = false
    // Key gone (different machine / keychain locked): degrade, do not crash.
    expect(openSecret(sealed)).toBe("")
  })

  it("passes through a legacy untagged value", () => {
    expect(openSecret("raw-key-from-before-sealing")).toBe(
      "raw-key-from-before-sealing",
    )
  })
})

describe("SettingsStore secrets", () => {
  it("never writes an API key to disk in the clear", async () => {
    const { s, file } = await store()
    await s.setProviderConfig("claude", { env: { ANTHROPIC_API_KEY: "sk-secret-xyz" } })
    const onDisk = await readFile(file, "utf8")
    expect(onDisk).not.toContain("sk-secret-xyz")
    expect(onDisk).toContain("enc:v1:")
  })

  it("hands the renderer key names only, never values", async () => {
    const { s } = await store()
    await s.setProviderConfig("claude", {
      binaryPath: "/opt/claude",
      env: { ANTHROPIC_API_KEY: "sk-secret-xyz" },
    })

    expect(s.getProviderEnvKeys("claude")).toEqual(["ANTHROPIC_API_KEY"])

    const redacted = s.redactedProviders()
    expect(redacted.claude).toEqual({
      binaryPath: "/opt/claude",
      defaultModel: undefined,
      enabled: undefined,
    })
    expect(JSON.stringify(redacted)).not.toContain("sk-secret-xyz")
    expect(JSON.stringify(redacted)).not.toContain("enc:v1:")
  })

  it("decrypts only for spawn, in main", async () => {
    const { s } = await store()
    await s.setProviderConfig("claude", { env: { ANTHROPIC_API_KEY: "sk-secret-xyz" } })
    expect(s.getProviderEnv("claude")).toEqual({ ANTHROPIC_API_KEY: "sk-secret-xyz" })
  })

  it("drops a key when its value is cleared, and keeps the others", async () => {
    const { s } = await store()
    await s.setProviderConfig("claude", {
      env: { ANTHROPIC_API_KEY: "a", ANTHROPIC_BASE_URL: "b" },
    })
    await s.setProviderConfig("claude", { env: { ANTHROPIC_API_KEY: "" } })
    expect(s.getProviderEnvKeys("claude")).toEqual(["ANTHROPIC_BASE_URL"])
  })

  it("keeps existing env when a later patch omits env entirely", async () => {
    const { s } = await store()
    await s.setProviderConfig("claude", { env: { ANTHROPIC_API_KEY: "a" } })
    await s.setProviderConfig("claude", { defaultModel: "opus" })
    expect(s.getProviderEnvKeys("claude")).toEqual(["ANTHROPIC_API_KEY"])
    expect(s.getProviderConfig("claude").defaultModel).toBe("opus")
  })
})

describe("SettingsStore persistence", () => {
  it("survives a reload", async () => {
    const { s, file } = await store()
    await s.setPermissionMode("acceptEdits")
    await s.setGeneralConfig({ defaultProvider: "grok" })
    await s.setProviderConfig("claude", { binaryPath: "  /opt/claude  " })

    const reloaded = new SettingsStore(file)
    await reloaded.load()
    expect(reloaded.permissionMode).toBe("acceptEdits")
    expect(reloaded.general.defaultProvider).toBe("grok")
    // Whitespace is trimmed before it reaches spawn.
    expect(reloaded.getProviderConfig("claude").binaryPath).toBe("/opt/claude")
  })

  it("falls back to defaults on a corrupt file instead of throwing", async () => {
    const { file } = await store()
    await writeFile(file, "{ not json", "utf8")
    const s = new SettingsStore(file)
    await s.load()
    expect(s.permissionMode).toBe("yolo")
    expect(s.listInstances()).toEqual([])
  })

  it("ignores a bogus permission mode and malformed instances on load", async () => {
    const { file } = await store()
    await writeFile(
      file,
      JSON.stringify({
        permissionMode: "chaos",
        instances: [{ id: "ok", provider: "claude" }, { nope: true }, null],
        providers: "not-an-object",
      }),
      "utf8",
    )
    const s = new SettingsStore(file)
    await s.load()
    expect(s.permissionMode).toBe("yolo")
    expect(s.listInstances().map((i) => i.id)).toEqual(["ok"])
    expect(s.redactedProviders()).toEqual({})
  })
})

describe("sanitizeGeneralPatch", () => {
  it("round-trips modes through the store, like the IPC handler does", async () => {
    const { s, file } = await store()
    const modes = [
      {
        id: "reviewer",
        name: "Reviewer",
        systemPrompt: "Review carefully.",
        model: "opus",
        effort: "high",
        permissionMode: "default",
      },
      { id: "blank", name: "Blank" },
    ]
    await s.setGeneralConfig(sanitizeGeneralPatch({ modes }))
    expect(s.general.modes).toEqual(modes)

    const reloaded = new SettingsStore(file)
    await reloaded.load()
    expect(reloaded.general.modes).toEqual(modes)
  })

  it("keeps the other whitelisted fields alongside modes", () => {
    expect(
      sanitizeGeneralPatch({
        defaultProvider: "grok",
        defaultEffort: "max",
        editor: "code",
        onboarded: true,
        modes: [],
      }),
    ).toEqual({
      defaultProvider: "grok",
      defaultEffort: "max",
      editor: "code",
      onboarded: true,
      modes: [],
    })
  })

  it("drops fields outside the whitelist", () => {
    expect(sanitizeGeneralPatch({ editor: "code", evil: "x" })).toEqual({
      editor: "code",
    })
  })

  it("rejects malformed modes instead of persisting them", () => {
    expect(() => sanitizeGeneralPatch({ modes: "nope" })).toThrow("Invalid modes")
    expect(() => sanitizeGeneralPatch({ modes: [null] })).toThrow("Invalid mode")
    expect(() => sanitizeGeneralPatch({ modes: [{ id: "a", name: "  " }] })).toThrow(
      "Invalid mode name",
    )
    expect(() =>
      sanitizeGeneralPatch({ modes: [{ id: "a", name: "A", effort: "chaos" }] }),
    ).toThrow("Invalid mode effort")
    expect(() =>
      sanitizeGeneralPatch({ modes: [{ id: "a", name: "A", permissionMode: "root" }] }),
    ).toThrow("Invalid mode permission")
    expect(() =>
      sanitizeGeneralPatch({ modes: [{ id: "a", name: "A", systemPrompt: 7 }] }),
    ).toThrow("Invalid mode prompt")
  })
})

describe("provider instances", () => {
  it("treats a provider id as its own default instance", async () => {
    const { s } = await store()
    await s.setProviderConfig("claude", { binaryPath: "/opt/claude", defaultModel: "opus" })
    const resolved = s.resolveInstance("claude")
    expect(resolved).toMatchObject({
      provider: "claude",
      instanceId: "claude",
      isExtra: false,
      binaryPath: "/opt/claude",
      defaultModel: "opus",
      enabled: true,
    })
  })

  it("gives an extra instance its own home so it resolves its own account", async () => {
    const { s } = await store()
    const extra = await s.addInstance("claude", {
      label: "Work",
      homeDir: "/tmp/work-claude",
    })
    const resolved = s.resolveInstance(extra.id)
    expect(resolved?.isExtra).toBe(true)
    expect(resolved?.label).toBe("Work")
    expect(resolved?.homeDir).toBe("/tmp/work-claude")
    expect(resolved?.env.CLAUDE_CONFIG_DIR).toBe("/tmp/work-claude")
  })

  it("returns null for an unknown instance id shape", async () => {
    const { s } = await store()
    expect(s.resolveInstance(undefined)).toBeNull()
  })

  it("refuses to resolve a removed instance as the default account", async () => {
    const { s } = await store()
    const extra = await s.addInstance("claude", { homeDir: "/tmp/work-claude" })
    await s.removeInstance(extra.id)
    // Falling back here would bill the personal subscription with no warning.
    expect(s.resolveInstance(extra.id)).toBeNull()
  })

  it("updates and removes instances", async () => {
    const { s } = await store()
    const extra = await s.addInstance("grok", { label: "Alt" })
    await s.updateInstance(extra.id, { label: "Renamed", enabled: false })
    expect(s.resolveInstance(extra.id)?.label).toBe("Renamed")
    expect(s.resolveInstance(extra.id)?.enabled).toBe(false)
    await s.removeInstance(extra.id)
    expect(s.listInstances()).toEqual([])
  })

  it("providers are enabled unless explicitly turned off", async () => {
    const { s } = await store()
    expect(s.isProviderEnabled("codex")).toBe(true)
    await s.setProviderConfig("codex", { enabled: false })
    expect(s.isProviderEnabled("codex")).toBe(false)
  })
})

describe("shell state", () => {
  it("has no window geometry until one is saved", async () => {
    const { s } = await store()
    expect(s.windowState).toBeNull()
    expect(s.zoomLevel).toBe(0)
  })

  it("round-trips geometry and zoom through the settings file", async () => {
    const { s, file } = await store()
    await s.setWindowState({
      bounds: { x: 12, y: 34, width: 1400, height: 900 },
      maximized: true,
    })
    await s.setZoomLevel(2)

    const reloaded = new SettingsStore(file)
    await reloaded.load()
    expect(reloaded.windowState).toEqual({
      bounds: { x: 12, y: 34, width: 1400, height: 900 },
      maximized: true,
    })
    expect(reloaded.zoomLevel).toBe(2)
  })

  it("drops geometry it cannot trust rather than opening off-screen", async () => {
    const { s, file } = await store()
    await s.setZoomLevel(0)
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        window: { bounds: { x: 0, y: 0, width: "wide" } },
        zoomLevel: 99,
      }),
      "utf8",
    )
    await s.load()
    expect(s.windowState).toBeNull()
    // A hand-edited level is pulled back into range, not honoured.
    expect(s.zoomLevel).toBe(3)
  })

  it("keeps geometry when other settings are written", async () => {
    const { s } = await store()
    await s.setWindowState({
      bounds: { x: 1, y: 2, width: 1000, height: 700 },
      maximized: false,
    })
    await s.setGeneralConfig({ themeId: "dawn" })
    expect(s.windowState?.bounds.width).toBe(1000)
  })
})

