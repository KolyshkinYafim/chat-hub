import { compositeOver, contrastRatio, parseColorChannels } from "./contrast"

export const THEME_TOKENS = [
  "--bg",
  "--bg-sidebar",
  "--bg-elevated",
  "--bg-hover",
  "--bg-active",
  "--bg-row-active",
  "--border",
  "--border-soft",
  "--border-strong",
  "--text",
  "--text-secondary",
  "--text-muted",
  "--text-faint",
  "--accent",
  "--accent-2",
  "--on-accent",
  "--working",
  "--waiting",
  "--ok",
  "--danger",
  "--user-bg",
  "--code-bg",
  "--composer-bg",
  "--syntax-keyword",
  "--syntax-type",
  "--syntax-string",
  "--syntax-number",
  "--syntax-punct",
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]

export type ThemeDef = {
  id: string
  name: string
  builtin?: true
  tokens: Record<string, string>
}

/** Mirror of the `:root` palette in styles.css — swatch/editor fallback for tokens a theme leaves unset. */
export const BASE_TOKENS: Record<ThemeToken, string> = {
  "--bg": "#0c0d12",
  "--bg-sidebar": "#131419",
  "--bg-elevated": "#1b1c21",
  "--bg-hover": "#232429",
  "--bg-active": "#2b2c32",
  "--bg-row-active": "#35373c",
  "--border": "#34353b",
  "--border-soft": "#24262b",
  "--border-strong": "#515258",
  "--text": "#ebecf1",
  "--text-secondary": "#c3c6d1",
  "--text-muted": "#9fa1ac",
  "--text-faint": "#848691",
  "--accent": "#88a7fd",
  "--accent-2": "#6e8de3",
  "--on-accent": "#0d1019",
  "--working": "#5dc7cb",
  "--waiting": "#ddb466",
  "--ok": "#71c589",
  "--danger": "#f48684",
  "--user-bg": "#1d2435",
  "--code-bg": "#121317",
  "--composer-bg": "#16181d",
  "--syntax-keyword": "#ccaaf5",
  "--syntax-type": "#82c8e3",
  "--syntax-string": "#98cd8c",
  "--syntax-number": "#e9af7c",
  "--syntax-punct": "#9fa1ac",
}

const TOKEN_SET: ReadonlySet<string> = new Set(THEME_TOKENS)

const COLOR_RE =
  /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d{1,3}(?:\s*,\s*\d{1,3}){2}(?:\s*,\s*(?:0|1|0?\.\d{1,4}))?\s*\)|hsla?\(\s*\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d{1,4}))?\s*\))$/

export function isThemeColor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && COLOR_RE.test(value)
}

/**
 * Defensive parse of an untrusted theme (import / settings file): unknown
 * tokens and non-color values are dropped, structural garbage returns null.
 * The parsed values land in inline style attributes, hence the allowlist.
 */
export function parseThemeDef(input: unknown): ThemeDef | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null
  const id = raw.id.trim()
  const name = raw.name.trim()
  if (!id || !name || id.length > 64 || name.length > 64) return null
  if (!raw.tokens || typeof raw.tokens !== "object" || Array.isArray(raw.tokens))
    return null
  const tokens: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw.tokens as Record<string, unknown>)) {
    if (!TOKEN_SET.has(key)) continue
    if (!isThemeColor(value)) continue
    tokens[key] = value
  }
  return { id, name, tokens }
}

export const BUILTIN_THEMES: ThemeDef[] = [
  { id: "midnight", name: "Midnight", builtin: true, tokens: {} },
  {
    id: "graphite",
    name: "Graphite",
    builtin: true,
    tokens: {
      "--bg": "#120d08",
      "--bg-sidebar": "#19140f",
      "--bg-elevated": "#211b17",
      "--bg-hover": "#29231f",
      "--bg-active": "#312c27",
      "--bg-row-active": "#3c3631",
      "--border": "#3a342f",
      "--border-soft": "#2a2520",
      "--border-strong": "#58514c",
      "--text": "#f0ece8",
      "--text-secondary": "#d0c4ba",
      "--text-muted": "#aba096",
      "--text-faint": "#90847b",
      // Graphite is the warm theme, so its accent shares a band with amber
      // "waiting" and red "danger". A deeper, quieter bronze steps clear of
      // both and leaves the four status colours identical across every theme.
      "--accent": "#c2946c",
      "--accent-2": "#a97b52",
      "--on-accent": "#170f07",
      "--user-bg": "#302113",
      "--code-bg": "#17120d",
      "--composer-bg": "#1c1712",
      "--syntax-punct": "#aba096",
    },
  },
  {
    id: "abyss",
    name: "Abyss",
    builtin: true,
    tokens: {
      "--bg": "#040e1b",
      "--bg-sidebar": "#091623",
      "--bg-elevated": "#101e2b",
      "--bg-hover": "#182634",
      "--bg-active": "#202e3c",
      "--bg-row-active": "#2a3847",
      "--border": "#293745",
      "--border-soft": "#1a2735",
      "--border-strong": "#455464",
      "--text": "#e4eefa",
      "--text-secondary": "#aecae7",
      "--text-muted": "#8aa5c2",
      "--text-faint": "#708aa5",
      "--accent": "#6da7f1",
      "--accent-2": "#528dd8",
      "--on-accent": "#0a1119",
      "--user-bg": "#192535",
      "--code-bg": "#071421",
      "--composer-bg": "#0c1926",
      "--syntax-punct": "#8aa5c2",
    },
  },
  {
    id: "daylight",
    name: "Daylight",
    builtin: true,
    tokens: {
      "--bg": "#f6f7fb",
      "--bg-sidebar": "#ebecf0",
      "--bg-elevated": "#ffffff",
      "--bg-hover": "#e4e5e9",
      "--bg-active": "#d9dadd",
      "--bg-row-active": "#cecfd2",
      "--border": "#cfcfd3",
      "--border-soft": "#dfe0e3",
      "--border-strong": "#adaeb2",
      "--text": "#1f2024",
      "--text-secondary": "#3d404a",
      "--text-muted": "#555762",
      "--text-faint": "#656772",
      "--accent": "#3e5cc7",
      "--accent-2": "#2841ae",
      "--on-accent": "#ffffff",
      "--working": "#007b7f",
      "--waiting": "#896301",
      "--ok": "#247d46",
      "--danger": "#aa4446",
      "--user-bg": "#e0e8fd",
      "--code-bg": "#eff0f4",
      "--composer-bg": "#ffffff",
      "--syntax-keyword": "#7b41af",
      "--syntax-type": "#007098",
      "--syntax-string": "#207800",
      "--syntax-number": "#9c4900",
      "--syntax-punct": "#555762",
    },
  },
]

export const GLASS_SURFACE_TOKENS: Partial<Record<ThemeToken, string>> = {
  "--bg": "rgba(12, 13, 18, 0.22)",
  "--bg-sidebar": "rgba(19, 20, 25, 0.66)",
  "--bg-elevated": "rgba(26, 29, 38, 0.55)",
  "--bg-hover": "rgba(35, 36, 41, 0.48)",
  "--bg-active": "rgba(43, 44, 50, 0.58)",
  "--bg-row-active": "rgba(53, 55, 60, 0.66)",
  "--border": "rgba(255, 255, 255, 0.09)",
  "--border-soft": "rgba(255, 255, 255, 0.06)",
  "--border-strong": "rgba(255, 255, 255, 0.16)",
  "--user-bg": "rgba(29, 36, 53, 0.58)",
  "--code-bg": "rgba(18, 19, 23, 0.88)",
  "--composer-bg": "rgba(22, 24, 29, 0.62)",
}

export const GLASS_SCRIM = "rgba(12, 13, 18, 0.88)"
export const GLASS_CLEAR = "rgba(0, 0, 0, 0)"

export function withGlassSurfaces(def: ThemeDef): ThemeDef {
  const source = isLightTheme(def) ? BASE_TOKENS : { ...BASE_TOKENS, ...def.tokens }
  return {
    id: def.id,
    name: def.name,
    tokens: { ...source, ...GLASS_SURFACE_TOKENS },
  }
}

export function contrastOnGlass(
  text: string,
  surface: string,
  dim: string,
  wallpaper: string,
): number | null {
  const floor = compositeOver(dim, wallpaper)
  if (!floor) return null
  const painted = compositeOver(surface, floor)
  if (!painted) return null
  return contrastRatio(text, painted)
}

export const DEFAULT_THEME_ID = "midnight"

/** True when the theme's background is light — drives the `theme-light` class that remaps dark-only hard-coded colors. */
export function isLightTheme(def: ThemeDef): boolean {
  const bg = def.tokens["--bg"] ?? BASE_TOKENS["--bg"]
  const ch = parseColorChannels(bg)
  if (!ch) return false
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 140
}

export function resolveTheme(
  themeId: string | undefined,
  customThemes: ThemeDef[] | undefined,
): ThemeDef {
  const found =
    BUILTIN_THEMES.find((t) => t.id === themeId) ??
    customThemes?.find((t) => t.id === themeId)
  return found ?? BUILTIN_THEMES[0]
}

export function themeBackground(def: ThemeDef): string {
  return def.tokens["--bg"] ?? BASE_TOKENS["--bg"]
}
