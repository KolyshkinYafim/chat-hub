import { describe, expect, it } from "vitest"
import { applyStatusesToProviders } from "@renderer/lib/provider-status"
import type { ProviderId, ProviderInfo } from "@shared/types"
import type { ProviderStatus } from "@shared/settings-types"

function info(id: ProviderId, available: boolean): ProviderInfo {
  return { id, label: id, available, description: "" }
}

function probed(
  id: ProviderId,
  installed: boolean,
  isExtra = false,
): ProviderStatus {
  return {
    id,
    instanceId: isExtra ? `${id}-extra` : id,
    homeDir: null,
    isExtra,
    label: id,
    installed,
    binaryPath: installed ? `/usr/local/bin/${id}` : null,
    version: installed ? "1.0.0" : null,
    auth: installed ? "connected" : "not_installed",
    authDetail: "",
    models: [],
    defaultModel: null,
    loginCommand: null,
    docsUrl: null,
    enabled: true,
    envKeys: [],
    envHints: [],
  }
}

describe("applyStatusesToProviders", () => {
  it("flips availability to match a fresh probe", () => {
    const providers = [info("claude", false), info("codex", true)]
    const next = applyStatusesToProviders(providers, [
      probed("claude", true),
      probed("codex", false),
    ])
    expect(next.map((p) => [p.id, p.available])).toEqual([
      ["claude", true],
      ["codex", false],
    ])
  })

  it("returns the same array when nothing changed", () => {
    const providers = [info("claude", true), info("mock", true)]
    const next = applyStatusesToProviders(providers, [
      probed("claude", true),
      probed("mock", true),
    ])
    expect(next).toBe(providers)
  })

  it("ignores extra instances when deciding availability", () => {
    const providers = [info("claude", true)]
    const next = applyStatusesToProviders(providers, [
      probed("claude", false, true),
    ])
    expect(next).toBe(providers)
    expect(next[0].available).toBe(true)
  })

  it("keeps providers the probe did not mention", () => {
    const providers = [info("claude", true), info("grok", false)]
    const next = applyStatusesToProviders(providers, [probed("claude", false)])
    expect(next.map((p) => [p.id, p.available])).toEqual([
      ["claude", false],
      ["grok", false],
    ])
  })
})
