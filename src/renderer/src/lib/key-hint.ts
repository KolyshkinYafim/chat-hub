const MAC_MODS: Record<string, string> = {
  "⌘": "Ctrl",
  "⌃": "Ctrl",
  "⌥": "Alt",
  "⇧": "Shift",
}

const MAC_KEYS: Record<string, string> = {
  "⇥": "Tab",
  "↩": "Enter",
}

export function hostPlatform(): string {
  if (typeof window !== "undefined") {
    const hub = (window as { chatHub?: { platform?: string } }).chatHub
    if (typeof hub?.platform === "string") return hub.platform
  }
  return "darwin"
}

export function keyHint(
  text: string,
  platform: string = hostPlatform(),
): string {
  if (platform === "darwin") return text
  let out = ""
  let joining = false
  for (const ch of text) {
    const mod = MAC_MODS[ch]
    if (mod) {
      out += joining ? `+${mod}` : mod
      joining = true
      continue
    }
    const key = MAC_KEYS[ch] ?? ch
    out += joining && key.trim() ? `+${key}` : key
    joining = false
  }
  return out
}
