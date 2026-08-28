import { describe, expect, it } from "vitest"
import {
  applyStatusesToProviders,
  formatCheckedAgo,
} from "@renderer/lib/provider-status"
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

describe("formatCheckedAgo", () => {
  const now = 10 * 60 * 60_000

  it("says just now inside the first minute", () => {
    expect(formatCheckedAgo(now - 59_000, now)).toBe("checked just now")
  })

  it("counts whole minutes under an hour", () => {
    expect(formatCheckedAgo(now - 60_000, now)).toBe("checked 1 min ago")
    expect(formatCheckedAgo(now - 59 * 60_000, now)).toBe("checked 59 min ago")
  })

  it("switches to hours and then days", () => {
    expect(formatCheckedAgo(now - 60 * 60_000, now)).toBe("checked 1 h ago")
    expect(formatCheckedAgo(now - 23 * 60 * 60_000, now)).toBe(
      "checked 23 h ago",
    )
    expect(formatCheckedAgo(now - 48 * 60 * 60_000, now)).toBe(
      "checked 2 d ago",
    )
  })

  it("treats a clock that ran backwards as just now", () => {
    expect(formatCheckedAgo(now + 5 * 60_000, now)).toBe("checked just now")
  })
})
