import type { WebContents, WebPreferences } from "electron"

const ALLOWED_GUEST_PROTOCOLS = ["http:", "https:"]
const ALLOWED_GUEST_LITERALS = ["about:blank", ""]

export function isAllowedGuestUrl(url: unknown): boolean {
  if (typeof url !== "string") return false
  if (ALLOWED_GUEST_LITERALS.includes(url)) return true
  try {
    return ALLOWED_GUEST_PROTOCOLS.includes(new URL(url).protocol)
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
}

export function hardenWebviewHost(
  host: WebContents,
  openExternally: (url: string) => void,
): void {
  host.on("will-attach-webview", (event, preferences, params) => {
    lockDownGuestPreferences(preferences)
    if (!isAllowedGuestUrl(params.src)) event.preventDefault()
  })

  host.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (isAllowedGuestUrl(url)) openExternally(url)
      return { action: "deny" }
    })
    guest.on("will-navigate", (navigation, url) => {
      if (!isAllowedGuestUrl(url)) navigation.preventDefault()
    })
  })
}
