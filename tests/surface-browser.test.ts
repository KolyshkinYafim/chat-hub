import { describe, expect, it } from "vitest"
import type { WebPreferences } from "electron"
import {
  isAllowedGuestUrl,
  isMediaGuestUrl,
  isNavigationAllowed,
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

describe("media guest urls", () => {
  it("recognises a minted media grant and nothing else", () => {
    expect(isMediaGuestUrl("chathub-media://stream/abc-123")).toBe(true)
    expect(isMediaGuestUrl("https://example.com/a.pdf")).toBe(false)
    expect(isMediaGuestUrl("file:///tmp/a.pdf")).toBe(false)
    expect(isMediaGuestUrl("chathub-mediax://stream/abc")).toBe(false)
    expect(isMediaGuestUrl("")).toBe(false)
    expect(isMediaGuestUrl(null)).toBe(false)
  })
})

describe("guest navigation", () => {
  const media = "chathub-media://stream/abc-123"

  it("keeps a file guest on the media scheme", () => {
    expect(isNavigationAllowed(media, "chathub-media://stream/other")).toBe(true)
    expect(isNavigationAllowed(media, "https://example.com")).toBe(false)
    expect(isNavigationAllowed(media, "file:///etc/passwd")).toBe(false)
    expect(isNavigationAllowed(media, "javascript:alert(1)")).toBe(false)
  })

  it("keeps a browsing guest on the web", () => {
    expect(isNavigationAllowed("https://a.example", "https://b.example")).toBe(
      true,
    )
    expect(isNavigationAllowed("https://a.example", media)).toBe(false)
    expect(isNavigationAllowed("https://a.example", "file:///etc/passwd")).toBe(
      false,
    )
  })
})

describe("guest web preferences", () => {
  it("strips node access and plugins whatever the tag asked for", () => {
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
      plugins: true,
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
    expect(asked.plugins).toBe(false)
  })
})
