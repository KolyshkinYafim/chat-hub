import { isLightTheme, THEME_TOKENS, type ThemeDef } from "@shared/theme"

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
}
