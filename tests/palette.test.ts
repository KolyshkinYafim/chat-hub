import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  AA_TEXT,
  AA_UI,
  colorDifference,
  contrastRatio,
  lightnessGap,
} from "@shared/contrast"
import {
  BASE_TOKENS,
  BUILTIN_THEMES,
  THEME_TOKENS,
  type ThemeDef,
  type ThemeToken,
} from "@shared/theme"

const ROOT = resolve(__dirname, "..")
const STYLES = readFileSync(resolve(ROOT, "src/renderer/src/styles.css"), "utf8")
const TRANSCRIPT = readFileSync(
  resolve(ROOT, "src/renderer/src/transcript.css"),
  "utf8",
)

/** Neighbouring surfaces below this OKLab gap have no visible edge between them. */
const MIN_SURFACE_GAP = 0.028
/** Two colours that mean different things must be at least this far apart. */
const MIN_ROLE_GAP = 0.085

type Palette = Record<ThemeToken, string>

function paletteOf(theme: ThemeDef): Palette {
  return { ...BASE_TOKENS, ...theme.tokens } as Palette
}

function ratio(fg: string, bg: string): number {
  const r = contrastRatio(fg, bg)
  expect(r).not.toBeNull()
  return r as number
}

/** Every text token, against every surface it is actually painted on. */
const TEXT_PAIRS: [ThemeToken, ThemeToken][] = [
  ["--text", "--bg"],
  ["--text", "--bg-sidebar"],
  ["--text", "--bg-elevated"],
  ["--text", "--bg-row-active"],
  ["--text", "--composer-bg"],
  ["--text", "--user-bg"],
  ["--text-secondary", "--bg"],
  ["--text-secondary", "--bg-sidebar"],
  ["--text-secondary", "--bg-elevated"],
  ["--text-secondary", "--user-bg"],
  ["--text-muted", "--bg"],
  ["--text-muted", "--bg-sidebar"],
  ["--text-muted", "--bg-elevated"],
  ["--text-muted", "--bg-row-active"],
  ["--text-muted", "--composer-bg"],
  ["--text-faint", "--bg"],
  ["--text-faint", "--bg-sidebar"],
  ["--text-faint", "--bg-elevated"],
  ["--text-faint", "--code-bg"],
  ["--syntax-keyword", "--code-bg"],
  ["--syntax-type", "--code-bg"],
  ["--syntax-string", "--code-bg"],
  ["--syntax-number", "--code-bg"],
  ["--syntax-punct", "--code-bg"],
  // Links, status text and the label on a primary button are all text too.
  ["--accent", "--bg"],
  ["--accent", "--bg-elevated"],
  ["--accent", "--code-bg"],
  ["--working", "--bg"],
  ["--working", "--bg-elevated"],
  ["--waiting", "--bg"],
  ["--waiting", "--bg-elevated"],
  ["--ok", "--bg"],
  ["--ok", "--bg-elevated"],
  ["--danger", "--bg"],
  ["--danger", "--bg-elevated"],
  ["--on-accent", "--accent-2"],
  ["--on-accent", "--accent"],
]

/** --accent-2 is a solid fill, so it answers to the non-text UI floor. */
const FILL_PAIRS: [ThemeToken, ThemeToken][] = [
  ["--accent-2", "--bg"],
  ["--accent-2", "--bg-elevated"],
]

/** The surface ramp, in the order a reader stacks it. */
const SURFACE_STEPS: [ThemeToken, ThemeToken][] = [
  ["--bg", "--bg-sidebar"],
  ["--bg-sidebar", "--bg-elevated"],
  ["--bg-elevated", "--bg-hover"],
  ["--bg-hover", "--bg-active"],
  ["--bg-active", "--bg-row-active"],
  ["--border-soft", "--border"],
  ["--border", "--border-strong"],
  ["--border", "--bg-elevated"],
]

/** Five colours that each carry one meaning; none may stand in for another. */
const ROLES: ThemeToken[] = [
  "--accent",
  "--working",
  "--waiting",
  "--ok",
  "--danger",
]

describe.each(BUILTIN_THEMES.map((t) => [t.name, t] as const))(
  "%s palette",
  (_name, theme) => {
    const p = paletteOf(theme)

    it.each(TEXT_PAIRS)("%s on %s clears WCAG AA", (fg, bg) => {
      expect(ratio(p[fg], p[bg])).toBeGreaterThanOrEqual(AA_TEXT)
    })

    it.each(FILL_PAIRS)("%s on %s clears the non-text floor", (fg, bg) => {
      expect(ratio(p[fg], p[bg])).toBeGreaterThanOrEqual(AA_UI)
    })

    it.each(SURFACE_STEPS)("%s separates from %s", (a, b) => {
      expect(lightnessGap(p[a], p[b])).toBeGreaterThanOrEqual(MIN_SURFACE_GAP)
    })

    it("keeps every meaning on its own colour", () => {
      const tooClose: string[] = []
      for (let i = 0; i < ROLES.length; i++) {
        for (let j = i + 1; j < ROLES.length; j++) {
          const d = colorDifference(p[ROLES[i]], p[ROLES[j]]) ?? 0
          if (d < MIN_ROLE_GAP) {
            tooClose.push(`${ROLES[i]}/${ROLES[j]} = ${d.toFixed(3)}`)
          }
        }
      }
      expect(tooClose).toEqual([])
    })

    it("defines every curated token", () => {
      for (const token of THEME_TOKENS) {
        expect(typeof p[token]).toBe("string")
      }
    })
  },
)

describe("stylesheet and token table agree", () => {
  const root = STYLES.slice(STYLES.indexOf(":root {"))
  const block = root.slice(0, root.indexOf("\n}"))
  const declared: Record<string, string> = {}
  for (const m of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    declared[m[1]] = m[2].trim()
  }

  it("BASE_TOKENS mirrors the :root palette exactly", () => {
    // The theme editor swatches read BASE_TOKENS; the app reads :root. A drift
    // between them shows up as a swatch that does not match the running UI.
    const fromCss: Record<string, string> = {}
    for (const token of THEME_TOKENS) fromCss[token] = declared[token]
    expect(fromCss).toEqual(BASE_TOKENS)
  })
})

describe("no rule re-hardcodes a colour a token already owns", () => {
  // Every literal here used to appear in a rule, which is why the accent could
  // not follow the theme and the light override file had to grow a patch for
  // each one.
  const retired = [
    "124, 140, 255",
    "91, 141, 239",
    "92, 110, 190",
    "240, 180, 41",
    "240, 200, 70",
    "240, 113, 120",
    "61, 214, 140",
    "77, 159, 255",
    "#c5ccff",
    "#f0c14b",
    "#d9ad55",
    "#f4d58a",
    "#e6a23c",
    "#ffb4b8",
    "#f0a9ad",
    "#f07178",
    "#9be9c0",
    "#3ecf8e",
    "#3dd68c",
  ]

  it.each(retired)("%s is gone from the stylesheets", (literal) => {
    const body = STYLES.slice(STYLES.indexOf("\n}\n"))
    expect(body).not.toContain(literal)
    expect(TRANSCRIPT).not.toContain(literal)
  })
})
