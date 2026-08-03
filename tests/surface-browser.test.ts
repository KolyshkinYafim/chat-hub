import { describe, expect, it } from "vitest"
import type { WebPreferences } from "electron"
import {
  isAllowedGuestUrl,
  lockDownGuestPreferences,
} from "../src/main/surfaces/browser"

describe("webview guest urls", () => {
  it("allows http, https and about:blank", () => {
    expect(isAllowedGuestUrl("http://localhost:5173/")).toBe(true)
    expect(isAllowedGuestUrl("https://example.com/path?q=1")).toBe(true)
    expect(isAllowedGuestUrl("about:blank")).toBe(true)
    expect(isAllowedGuestUrl("")).toBe(true)
  })

  it("denies every other scheme", () => {
    expect(isAllowedGuestUrl("file:///etc/passwd")).toBe(false)
    expect(isAllowedGuestUrl("javascript:alert(1)")).toBe(false)
    expect(isAllowedGuestUrl("data:text/html,<script>1</script>")).toBe(false)
    expect(isAllowedGuestUrl("chrome://settings")).toBe(false)
    expect(isAllowedGuestUrl("about:credits")).toBe(false)
    expect(isAllowedGuestUrl("not a url")).toBe(false)
    expect(isAllowedGuestUrl(undefined)).toBe(false)
    expect(isAllowedGuestUrl(null)).toBe(false)
    expect(isAllowedGuestUrl(42)).toBe(false)
  })
})

describe("guest web preferences", () => {
  it("strips node access whatever the tag asked for", () => {
    const asked: WebPreferences = {
      preload: "/tmp/evil.js",
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
    }

    lockDownGuestPreferences(asked)

    expect(asked.preload).toBeUndefined()
    expect(asked.nodeIntegration).toBe(false)
    expect(asked.nodeIntegrationInWorker).toBe(false)
    expect(asked.nodeIntegrationInSubFrames).toBe(false)
    expect(asked.contextIsolation).toBe(true)
    expect(asked.sandbox).toBe(true)
    expect(asked.webviewTag).toBe(false)
    expect(asked.allowRunningInsecureContent).toBe(false)
    expect(asked.experimentalFeatures).toBe(false)
  })
})
