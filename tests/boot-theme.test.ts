import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"
import {
  BASE_TOKENS,
  BUILTIN_THEMES,
  resolveTheme,
  themeBackground,
  type ThemeDef,
} from "../src/shared/theme"
import {
  applyTheme,
  bootThemeSnapshot,
  BOOT_THEME_KEY,
  BOOT_THEME_TOKENS,
} from "../src/renderer/src/lib/theme-apply"

const daylight = BUILTIN_THEMES.find((t) => t.id === "daylight")!

function fakeRoot() {
  const set = new Map<string, string>()
  const classes = new Set<string>()
  return {
    set,
    classes,
    root: {
      style: {
        setProperty: (key: string, value: string) => {
          set.set(key, value)
        },
        removeProperty: (key: string) => {
          set.delete(key)
        },
      },
      classList: {
        toggle: (name: string, on: boolean) => {
          if (on) classes.add(name)
          else classes.delete(name)
        },
        add: (name: string) => {
          classes.add(name)
        },
        contains: (name: string) => classes.has(name),
      },
    } as unknown as HTMLElement,
  }
}

type StorageStub = { store: Map<string, string> }

function stubLocalStorage(): StorageStub {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
    },
  })
  return { store }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage
})

describe("bootThemeSnapshot", () => {
  it("falls back to the stylesheet palette for tokens a theme leaves unset", () => {
    const midnight = resolveTheme("midnight", undefined)
    const snap = bootThemeSnapshot(midnight)
    expect(snap.light).toBe(false)
    for (const token of BOOT_THEME_TOKENS) {
      expect(snap.tokens[token]).toBe(BASE_TOKENS[token])
    }
  })

  it("captures a light theme's own colors and flags it light", () => {
    const snap = bootThemeSnapshot(daylight)
    expect(snap.light).toBe(true)
    expect(snap.tokens["--bg"]).toBe("#f6f7fb")
    expect(snap.tokens["--bg-sidebar"]).toBe("#ebecf0")
    expect(snap.tokens["--text"]).toBe("#1f2024")
  })
})

describe("themeBackground", () => {
  it("prefers the theme's own --bg and falls back to the base palette", () => {
    expect(themeBackground(daylight)).toBe("#f6f7fb")
    expect(themeBackground(resolveTheme("midnight", undefined))).toBe(
      BASE_TOKENS["--bg"],
    )
    const custom: ThemeDef = { id: "x", name: "x", tokens: {} }
    expect(themeBackground(custom)).toBe(BASE_TOKENS["--bg"])
  })
})

describe("applyTheme persistence", () => {
  it("writes the resolved boot snapshot to localStorage", () => {
    const { store } = stubLocalStorage()
    const { root, classes } = fakeRoot()
    applyTheme(daylight, root)
    expect(classes.has("theme-light")).toBe(true)
    const raw = store.get(BOOT_THEME_KEY)
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!)
    expect(parsed).toEqual(bootThemeSnapshot(daylight))
  })

  it("still applies the theme when localStorage is unavailable", () => {
    const { root, set } = fakeRoot()
    expect(() => applyTheme(daylight, root)).not.toThrow()
    expect(set.get("--bg")).toBe("#f6f7fb")
  })
})

describe("boot-theme.js", () => {
  const src = readFileSync(
    join(__dirname, "..", "src", "renderer", "public", "boot-theme.js"),
    "utf8",
  )

  function run(stored: Record<string, string>, search = "") {
    const set = new Map<string, string>()
    const classes = new Set<string>()
    const documentStub = {
      documentElement: {
        style: {
          setProperty: (key: string, value: string) => {
            set.set(key, value)
          },
        },
        classList: {
          add: (name: string) => {
            classes.add(name)
          },
          remove: (name: string) => {
            classes.delete(name)
          },
        },
      },
    }
    const localStorageStub = {
      getItem: (key: string) => stored[key] ?? null,
    }
    runInNewContext(src, {
      document: documentStub,
      localStorage: localStorageStub,
      location: { search },
    })
    return { set, classes }
  }

  it("applies persisted tokens and the light class before first paint", () => {
    const { set, classes } = run({
      [BOOT_THEME_KEY]: JSON.stringify(bootThemeSnapshot(daylight)),
    })
    expect(set.get("--bg")).toBe("#f6f7fb")
    expect(set.get("--bg-sidebar")).toBe("#ebecf0")
    expect(set.get("--border-soft")).toBe("#dfe0e3")
    expect(classes.has("theme-light")).toBe(true)
  })

  it("ignores values that do not look like colors", () => {
    const { set, classes } = run({
      [BOOT_THEME_KEY]: JSON.stringify({
        light: false,
        tokens: {
          "--bg": "url(https://evil.example/x)",
          "--bg-sidebar": "#131419; background: red",
          "not a token": "#ffffff",
          "--text": "#abcdef",
        },
      }),
    })
    expect(set.has("--bg")).toBe(false)
    expect(set.has("--bg-sidebar")).toBe(false)
    expect(set.get("--text")).toBe("#abcdef")
    expect(classes.has("theme-light")).toBe(false)
  })

  it("applies the persisted sidebar width clamped to its bounds", () => {
    expect(run({ "chat-hub.sidebar.width": "300" }).set.get("--sidebar-w")).toBe(
      "300px",
    )
    expect(run({ "chat-hub.sidebar.width": "90" }).set.get("--sidebar-w")).toBe(
      "200px",
    )
    expect(run({ "chat-hub.sidebar.width": "9000" }).set.get("--sidebar-w")).toBe(
      "420px",
    )
    expect(run({ "chat-hub.sidebar.width": "wide" }).set.has("--sidebar-w")).toBe(
      false,
    )
  })

  it("does nothing on a first launch with empty storage", () => {
    const { set, classes } = run({})
    expect(set.size).toBe(0)
    expect(classes.size).toBe(0)
  })

  it("survives corrupt stored JSON", () => {
    const { set } = run({
      [BOOT_THEME_KEY]: "{oops",
      "chat-hub.sidebar.width": "260",
    })
    expect(set.get("--sidebar-w")).toBe("260px")
  })

  it("applies glass surface tokens in a cockpit window", () => {
    const { set, classes } = run(
      { [BOOT_THEME_KEY]: JSON.stringify(bootThemeSnapshot(daylight)) },
      "?cockpit=1&vibrancy=hud",
    )
    expect(classes.has("cockpit")).toBe(true)
    expect(classes.has("theme-light")).toBe(false)
    expect(set.get("--bg-sidebar")).toBe("rgba(19, 20, 25, 0.66)")
    expect(set.get("--bg")).toBe("rgba(12, 13, 18, 0.22)")
  })
})
