import {
  BASE_TOKENS,
  isLightTheme,
  THEME_TOKENS,
  type ThemeDef,
  type ThemeToken,
} from "@shared/theme"

export const BOOT_THEME_KEY = "chat-hub.boot-theme"

export const BOOT_THEME_TOKENS = [
  "--bg",
  "--bg-sidebar",
  "--bg-elevated",
  "--border-soft",
  "--border-strong",
  "--composer-bg",
  "--text",
] as const satisfies readonly ThemeToken[]

export type BootThemeSnapshot = {
  light: boolean
  tokens: Record<string, string>
}

export function bootThemeSnapshot(def: ThemeDef): BootThemeSnapshot {
  const tokens: Record<string, string> = {}
  for (const token of BOOT_THEME_TOKENS) {
    tokens[token] = def.tokens[token] ?? BASE_TOKENS[token]
  }
  return { light: isLightTheme(def), tokens }
}

function persistBootTheme(def: ThemeDef): void {
  try {
    localStorage.setItem(BOOT_THEME_KEY, JSON.stringify(bootThemeSnapshot(def)))
  } catch {
    return
  }
}

/** Overrides win over `:root` via inline documentElement styles; unset tokens fall back to the stylesheet. */
export function applyTheme(
  def: ThemeDef,
  root: HTMLElement = document.documentElement,
): void {
  for (const token of THEME_TOKENS) {
    const value = def.tokens[token]
    if (value) root.style.setProperty(token, value)
    else root.style.removeProperty(token)
  }
  root.classList.toggle("theme-light", isLightTheme(def))
  persistBootTheme(def)
}
