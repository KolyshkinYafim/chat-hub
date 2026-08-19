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
  "--working",
  "--waiting",
  "--ok",
  "--danger",
  "--user-bg",
  "--code-bg",
  "--composer-bg",
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
  "--bg": "#0c0d10",
  "--bg-sidebar": "#101114",
  "--bg-elevated": "#16171c",
  "--bg-hover": "#1a1b21",
  "--bg-active": "#1e2028",
  "--bg-row-active": "#252730",
  "--border": "#2a2c35",
  "--border-soft": "#22242c",
  "--border-strong": "#3d4150",
  "--text": "#ececf1",
  "--text-secondary": "#c5c7d0",
  "--text-muted": "#8b8d98",
  "--text-faint": "#5c5e6a",
  "--accent": "#7c8cff",
  "--accent-2": "#5b8def",
  "--working": "#4d9fff",
  "--waiting": "#f0b429",
  "--ok": "#3dd68c",
  "--danger": "#f07178",
  "--user-bg": "#1a2332",
  "--code-bg": "#12141a",
  "--composer-bg": "#14151a",
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
      "--bg": "#131110",
      "--bg-sidebar": "#171412",
      "--bg-elevated": "#1d1a17",
      "--bg-hover": "#221e1b",
      "--bg-active": "#282320",
      "--bg-row-active": "#2f2a26",
      "--border": "#363029",
      "--border-soft": "#2b2621",
      "--border-strong": "#4d4438",
      "--text": "#f0ece5",
      "--text-secondary": "#d0c9bf",
      "--text-muted": "#988f82",
      "--text-faint": "#6a6156",
      "--accent": "#e2a65c",
      "--accent-2": "#d1913f",
      "--working": "#e2a65c",
      "--user-bg": "#292018",
      "--code-bg": "#1a1613",
      "--composer-bg": "#1b1714",
    },
  },
  {
    id: "abyss",
    name: "Abyss",
    builtin: true,
    tokens: {
      "--bg": "#0a0f1c",
      "--bg-sidebar": "#0d1322",
      "--bg-elevated": "#121a2e",
      "--bg-hover": "#162039",
      "--bg-active": "#1a2542",
      "--bg-row-active": "#212d4f",
      "--border": "#273554",
      "--border-soft": "#1f2a44",
      "--border-strong": "#394970",
      "--text": "#e8edf7",
      "--text-secondary": "#c3cde0",
      "--text-muted": "#8595b2",
      "--text-faint": "#576484",
      "--accent": "#54c2f0",
      "--accent-2": "#3ba3d6",
      "--working": "#54c2f0",
      "--user-bg": "#15253e",
      "--code-bg": "#0e1526",
      "--composer-bg": "#101828",
    },
  },
  {
    id: "daylight",
    name: "Daylight",
    builtin: true,
    tokens: {
      "--bg": "#f4f4f6",
      "--bg-sidebar": "#eaeaee",
      "--bg-elevated": "#ffffff",
      "--bg-hover": "#e3e3e9",
      "--bg-active": "#dbdbe2",
      "--bg-row-active": "#d1d2dc",
      "--border": "#cfd0d9",
      "--border-soft": "#dbdce2",
      "--border-strong": "#aeb0bf",
      "--text": "#1b1c22",
      "--text-secondary": "#3d3f49",
      "--text-muted": "#6f7280",
      "--text-faint": "#9b9ea9",
      "--accent": "#4d5cd3",
      "--accent-2": "#3467cd",
      "--working": "#2673dc",
      "--waiting": "#a3720c",
      "--ok": "#178f58",
      "--danger": "#cf3f4b",
      "--user-bg": "#e2eaf7",
      "--code-bg": "#ececf0",
      "--composer-bg": "#ffffff",
    },
  },
]

export const DEFAULT_THEME_ID = "midnight"

function colorChannels(value: string): [number, number, number] | null {
  const hex = value.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hex) {
    let h = hex[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join("")
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ]
  }
  const rgb = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hsl = value.match(/^hsla?\(\s*\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*(\d{1,3})%/)
  if (hsl) {
    const v = Math.round(Number(hsl[1]) * 2.55)
    return [v, v, v]
  }
  return null
}

/** True when the theme's background is light — drives the `theme-light` class that remaps dark-only hard-coded colors. */
export function isLightTheme(def: ThemeDef): boolean {
  const bg = def.tokens["--bg"] ?? BASE_TOKENS["--bg"]
  const ch = colorChannels(bg)
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
