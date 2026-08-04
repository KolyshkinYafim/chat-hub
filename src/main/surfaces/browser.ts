import type { WebContents, WebPreferences } from "electron"
import { MEDIA_SCHEME } from "@shared/surfaces"

const ALLOWED_GUEST_PROTOCOLS = ["http:", "https:"]
const ALLOWED_GUEST_LITERALS = ["about:blank", ""]
const MEDIA_PROTOCOL = `${MEDIA_SCHEME}:`

export function isAllowedGuestUrl(url: unknown): boolean {
  if (typeof url !== "string") return false
  if (ALLOWED_GUEST_LITERALS.includes(url)) return true
  try {
    return ALLOWED_GUEST_PROTOCOLS.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * A workspace file the media protocol already granted: an opaque per-file token
 * whose containment is re-checked at serve time. The PDF viewer runs in a guest
 * of its own on one of these, and may never leave the scheme.
 */
export function isMediaGuestUrl(url: unknown): boolean {
  if (typeof url !== "string") return false
  try {
    return new URL(url).protocol === MEDIA_PROTOCOL
  } catch {
    return false
  }
}

export function lockDownGuestPreferences(preferences: WebPreferences): void {
  delete preferences.preload
  preferences.nodeIntegration = false
  preferences.nodeIntegrationInWorker = false
  preferences.nodeIntegrationInSubFrames = false
  preferences.contextIsolation = true
  preferences.sandbox = true
  preferences.webviewTag = false
  preferences.allowRunningInsecureContent = false
  preferences.experimentalFeatures = false
  // Chromium renders PDFs without this, and nothing else in the Hub wants it,
  // so no guest gets it however the tag was written.
  preferences.plugins = false
}

export function hardenWebviewHost(
  host: WebContents,
  openExternally: (url: string) => void,
): void {
  host.on("will-attach-webview", (event, preferences, params) => {
    lockDownGuestPreferences(preferences)
    if (isMediaGuestUrl(params.src)) return
    if (!isAllowedGuestUrl(params.src)) event.preventDefault()
  })

  host.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (!isMediaGuestUrl(guest.getURL()) && isAllowedGuestUrl(url)) {
        openExternally(url)
      }
      return { action: "deny" }
    })
    guest.on("will-navigate", (navigation, url) => {
      if (!isNavigationAllowed(guest.getURL(), url)) navigation.preventDefault()
    })
  })
}

/** A file guest may only reach files, a browsing guest only the web. */
export function isNavigationAllowed(from: string, to: unknown): boolean {
  return isMediaGuestUrl(from) ? isMediaGuestUrl(to) : isAllowedGuestUrl(to)
}
