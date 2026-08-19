// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  BASE_TOKENS,
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  isLightTheme,
  isThemeColor,
  parseThemeDef,
  resolveTheme,
  THEME_TOKENS,
  type ThemeDef,
} from "@shared/theme"
import { applyTheme } from "@renderer/lib/theme-apply"

describe("parseThemeDef", () => {
  it("keeps valid tokens and identity", () => {
    const parsed = parseThemeDef({
      id: "night-owl",
      name: "Night Owl",
      tokens: { "--bg": "#101014", "--accent": "rgb(120, 130, 255)" },
    })
    expect(parsed).toEqual({
      id: "night-owl",
      name: "Night Owl",
      tokens: { "--bg": "#101014", "--accent": "rgb(120, 130, 255)" },
    })
  })

  it("drops unknown tokens", () => {
    const parsed = parseThemeDef({
      id: "x",
      name: "X",
      tokens: { "--bg": "#101014", "--evil": "#000000", background: "#fff" },
    })
    expect(parsed?.tokens).toEqual({ "--bg": "#101014" })
  })

  it("rejects values that are not plain CSS colors", () => {
    const parsed = parseThemeDef({
      id: "x",
      name: "X",
      tokens: {
        "--bg": 'url("http://evil")',
        "--text": "#fff; background: red",
        "--accent": "expression(alert(1))",
        "--danger": "var(--bg)",
        "--ok": "#3dd68c",
      },
    })
    expect(parsed?.tokens).toEqual({ "--ok": "#3dd68c" })
  })

  it("returns null for structural garbage", () => {
    expect(parseThemeDef(null)).toBeNull()
    expect(parseThemeDef("theme")).toBeNull()
    expect(parseThemeDef(42)).toBeNull()
    expect(parseThemeDef([])).toBeNull()
    expect(parseThemeDef({})).toBeNull()
    expect(parseThemeDef({ id: "x", name: "X" })).toBeNull()
    expect(parseThemeDef({ id: "x", name: "X", tokens: "nope" })).toBeNull()
    expect(parseThemeDef({ id: "", name: "X", tokens: {} })).toBeNull()
    expect(
      parseThemeDef({ id: "y".repeat(65), name: "X", tokens: {} }),
    ).toBeNull()
  })

  it("never marks a parsed theme as builtin", () => {
    const parsed = parseThemeDef({
      id: "x",
      name: "X",
      builtin: true,
      tokens: {},
    })
    expect(parsed?.builtin).toBeUndefined()
  })
})

describe("isThemeColor", () => {
  it("accepts hex, rgb and hsl forms", () => {
    expect(isThemeColor("#abc")).toBe(true)
    expect(isThemeColor("#aabbcc")).toBe(true)
    expect(isThemeColor("#aabbccdd")).toBe(true)
    expect(isThemeColor("rgba(1, 2, 3, 0.5)")).toBe(true)
    expect(isThemeColor("hsl(210, 40%, 20%)")).toBe(true)
  })

  it("rejects anything that could escape a style value", () => {
    expect(isThemeColor("red")).toBe(false)
    expect(isThemeColor("#fff }")).toBe(false)
    expect(isThemeColor("rgb(1,2,3); color: red")).toBe(false)
    expect(isThemeColor(12)).toBe(false)
  })
})

describe("builtins", () => {
  it("only use curated tokens with valid colors", () => {
    const known = new Set<string>(THEME_TOKENS)
    for (const theme of BUILTIN_THEMES) {
      for (const [token, value] of Object.entries(theme.tokens)) {
        expect(known.has(token)).toBe(true)
        expect(isThemeColor(value)).toBe(true)
      }
    }
  })

  it("survive parseThemeDef unchanged", () => {
    for (const theme of BUILTIN_THEMES) {
      const parsed = parseThemeDef(theme)
      expect(parsed).toEqual({
        id: theme.id,
        name: theme.name,
        tokens: theme.tokens,
      })
    }
  })

  it("default is Midnight with no overrides", () => {
    expect(BUILTIN_THEMES[0].id).toBe(DEFAULT_THEME_ID)
    expect(BUILTIN_THEMES[0].tokens).toEqual({})
  })

  it("BASE_TOKENS covers every curated token", () => {
    for (const token of THEME_TOKENS) {
      expect(isThemeColor(BASE_TOKENS[token])).toBe(true)
    }
  })
})

describe("resolveTheme", () => {
  const custom: ThemeDef[] = [{ id: "mine", name: "Mine", tokens: {} }]

  it("finds builtins and custom themes by id", () => {
    expect(resolveTheme("abyss", custom).name).toBe("Abyss")
    expect(resolveTheme("mine", custom).name).toBe("Mine")
  })

  it("falls back to Midnight for unknown or unset ids", () => {
    expect(resolveTheme("nope", custom).id).toBe(DEFAULT_THEME_ID)
    expect(resolveTheme(undefined, undefined).id).toBe(DEFAULT_THEME_ID)
  })
})

describe("applyTheme", () => {
  it("sets overridden tokens and clears the rest", () => {
    const root = document.createElement("div")
    applyTheme(
      { id: "t", name: "T", tokens: { "--bg": "#111213", "--accent": "#aabbcc" } },
      root,
    )
    expect(root.style.getPropertyValue("--bg")).toBe("#111213")
    expect(root.style.getPropertyValue("--accent")).toBe("#aabbcc")
    expect(root.style.getPropertyValue("--text")).toBe("")

    applyTheme({ id: "m", name: "M", tokens: { "--text": "#ffffff" } }, root)
    expect(root.style.getPropertyValue("--bg")).toBe("")
    expect(root.style.getPropertyValue("--accent")).toBe("")
    expect(root.style.getPropertyValue("--text")).toBe("#ffffff")

    applyTheme({ id: "e", name: "E", tokens: {} }, root)
    expect(root.style.getPropertyValue("--text")).toBe("")
  })

  it("defaults to document.documentElement", () => {
    applyTheme({ id: "t", name: "T", tokens: { "--bg": "#010203" } })
    expect(
      document.documentElement.style.getPropertyValue("--bg"),
    ).toBe("#010203")
    applyTheme({ id: "m", name: "M", tokens: {} })
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("")
  })
})

describe("isLightTheme", () => {
  it("classifies builtins by background luminance", () => {
    expect(isLightTheme(BUILTIN_THEMES.find((t) => t.id === "daylight")!)).toBe(
      true,
    )
    expect(isLightTheme(BUILTIN_THEMES.find((t) => t.id === "midnight")!)).toBe(
      false,
    )
    expect(isLightTheme(BUILTIN_THEMES.find((t) => t.id === "abyss")!)).toBe(
      false,
    )
  })

  it("handles rgb and hsl backgrounds", () => {
    expect(
      isLightTheme({ id: "x", name: "X", tokens: { "--bg": "rgb(250, 250, 250)" } }),
    ).toBe(true)
    expect(
      isLightTheme({ id: "x", name: "X", tokens: { "--bg": "hsl(0, 0%, 10%)" } }),
    ).toBe(false)
  })

  it("applyTheme toggles the theme-light class", () => {
    const root = document.createElement("div")
    applyTheme({ id: "l", name: "L", tokens: { "--bg": "#ffffff" } }, root)
    expect(root.classList.contains("theme-light")).toBe(true)
    applyTheme({ id: "d", name: "D", tokens: {} }, root)
    expect(root.classList.contains("theme-light")).toBe(false)
  })
})

describe("export / import round-trip", () => {
  it("re-parses an exported theme identically", () => {
    const theme = BUILTIN_THEMES.find((t) => t.id === "graphite")!
    const json = JSON.stringify({
      id: theme.id,
      name: theme.name,
      tokens: theme.tokens,
    })
    const parsed = parseThemeDef(JSON.parse(json))
    expect(parsed).toEqual({
      id: theme.id,
      name: theme.name,
      tokens: theme.tokens,
    })
  })
})
