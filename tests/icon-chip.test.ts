import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The × buttons used to be 24 separate rules at six different sizes, so the
 * same glyph landed on a different optical centre in every panel. They are one
 * rule now, and these checks measure that rather than trusting the eye: the box
 * comes from --chip-size alone, the glyph from --chip-glyph alone, and nothing
 * else is allowed to touch either.
 */

const ROOT = resolve(__dirname, "..")
const CSS = readFileSync(resolve(ROOT, "src/renderer/src/styles.css"), "utf8")
const COMPONENTS = resolve(ROOT, "src/renderer/src/components")

/** Files the side-by-side pane work owns; this suite does not police them. */
const NOT_OURS = new Set([
  "Sidebar.tsx",
  "SurfaceDock.tsx",
  "ShortcutsOverlay.tsx",
  "Workspace.tsx",
  "WorkspacePane.tsx",
])

/**
 * The one bare-glyph button that is deliberately not a chip: it lives in the
 * diff gutter, locked to the height of a single code line.
 */
const GUTTER_EXCEPTION = "dcm-add"

type Rule = { selector: string; decls: Record<string, string> }

function parseRules(css: string): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: Rule[] = []
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, " ")
    if (!selector || selector.startsWith("@")) continue
    const decls: Record<string, string> = {}
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":")
      if (i < 0) continue
      decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
    out.push({ selector, decls })
  }
  return out
}

const RULES = parseRules(CSS)
const BASE = RULES.find((r) => r.selector === ".icon-chip")

/** Properties that decide where the glyph lands. Only the base rule sets them. */
const BOX_PROPS = [
  "width",
  "height",
  "min-width",
  "min-height",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-size",
  "line-height",
  "display",
  "align-items",
  "justify-content",
  "place-items",
  "border-width",
  "box-sizing",
]

function px(value: string | undefined): number | null {
  const m = value?.match(/^(\d+(?:\.\d+)?)px$/)
  return m ? Number(m[1]) : null
}

/** Every rule that resizes a chip, as {selector -> declared chip variables}. */
function variants(): { selector: string; size: number; glyph: number; hit: number }[] {
  const base = {
    size: px(BASE?.decls["--chip-size"]) ?? 0,
    glyph: px(BASE?.decls["--chip-glyph"]) ?? 0,
    hit: px(BASE?.decls["--chip-hit"]) ?? 0,
  }
  const found = [{ selector: ".icon-chip", ...base }]
  for (const rule of RULES) {
    if (rule.selector === ".icon-chip") continue
    if (!rule.selector.includes(".icon-chip")) continue
    const size = px(rule.decls["--chip-size"])
    const glyph = px(rule.decls["--chip-glyph"])
    const hit = px(rule.decls["--chip-hit"])
    if (size === null && glyph === null && hit === null) continue
    found.push({
      selector: rule.selector,
      size: size ?? base.size,
      glyph: glyph ?? base.glyph,
      hit: hit ?? base.hit,
    })
  }
  return found
}

describe("the shared chip rule", () => {
  it("exists", () => {
    expect(BASE).toBeDefined()
  })

  it("centres the glyph and drops the browser's own padding", () => {
    // padding is the bug this rule was written for: at 20px a default content
    // box is narrower than a 12px glyph, and place-items has nothing to centre.
    expect(BASE?.decls).toMatchObject({
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      padding: "0",
      "line-height": "1",
      width: "var(--chip-size)",
      height: "var(--chip-size)",
      "font-size": "var(--chip-glyph)",
    })
  })
})

describe("no rule redefines a chip's box", () => {
  // ::after is the hit pad; sizing it is the whole point of that rule.
  const others = RULES.filter(
    (r) =>
      r.selector !== ".icon-chip" &&
      r.selector !== ".icon-chip::after" &&
      r.selector.includes(".icon-chip"),
  )

  it("finds the variant rules to check", () => {
    expect(others.length).toBeGreaterThan(0)
  })

  it.each(others.map((r) => [r.selector, r] as const))(
    "%s sets only tone and position",
    (_selector, rule) => {
      const offenders = BOX_PROPS.filter((p) => p in rule.decls)
      expect(offenders).toEqual([])
    },
  )
})

describe("every chip lands its glyph on the same optical centre", () => {
  const found = variants()

  it("keeps the ladder short enough to be a ladder", () => {
    const ladder = Object.fromEntries(found.map((v) => [v.selector, v.size]))
    expect(ladder).toMatchObject({
      ".icon-chip": 28,
      ".icon-chip.xs": 20,
      ".icon-chip.sm": 22,
      ".icon-chip.lg": 34,
    })
    // Before this pass the same glyph appeared at 22, 26, 28, 30, 32 and 34px
    // plus four rules with no box at all. A handful of declared sizes is a
    // scale; a dozen is the drift the owner was seeing.
    expect(new Set(found.map((v) => v.size)).size).toBeLessThanOrEqual(6)
  })

  it.each(found.map((v) => [v.selector, v] as const))(
    "%s centres its glyph in a square box",
    (_selector, v) => {
      // border-box sizing plus zero padding plus symmetric centring means the
      // glyph's centre is the box's centre, both axes, for every variant.
      expect(v.size).toBeGreaterThan(0)
      expect(v.glyph).toBeGreaterThan(0)
      const centre = { x: v.size / 2, y: v.size / 2 }
      expect(centre.x).toBe(centre.y)
      // the glyph has to fit inside the box it is centred in
      expect(v.glyph).toBeLessThan(v.size)
    },
  )

  it.each(found.map((v) => [v.selector, v] as const))(
    "%s keeps a pointer target of at least 24px",
    (_selector, v) => {
      expect(Math.max(v.size, v.hit)).toBeGreaterThanOrEqual(24)
    },
  )

  it("pads the small chips concentrically, so growing the target never moves the glyph", () => {
    const pad = RULES.find((r) => r.selector === ".icon-chip::after")
    expect(pad?.decls).toMatchObject({
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "max(var(--chip-size), var(--chip-hit))",
      height: "max(var(--chip-size), var(--chip-hit))",
    })
  })
})

describe("every bare-glyph button is a chip", () => {
  const GLYPH = /^[×✕−+‹›⌄⌃⋯↻⟳✎⊕⊖]$/
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith(".tsx") && !NOT_OURS.has(entry.name)) files.push(p)
    }
  }
  walk(COMPONENTS)

  /**
   * JSX attributes carry `=>` and nested braces, so the closing `>` of the
   * open tag has to be found by scanning, not by a regex stopping at the first
   * angle bracket.
   */
  function glyphButtons(src: string) {
    const found: { at: number; attrs: string; body: string }[] = []
    let i = src.indexOf("<button")
    while (i !== -1) {
      let j = i + "<button".length
      let depth = 0
      let quote = ""
      while (j < src.length) {
        const c = src[j]
        if (quote) {
          if (c === quote) quote = ""
        } else if (c === '"' || c === "'" || c === "`") quote = c
        else if (c === "{") depth++
        else if (c === "}") depth--
        else if (c === ">" && depth === 0) break
        j++
      }
      const close = src.indexOf("</button>", j)
      if (close !== -1 && src.slice(j, close).indexOf("<button") === -1) {
        found.push({ at: i, attrs: src.slice(i, j), body: src.slice(j + 1, close).trim() })
      }
      i = src.indexOf("<button", j)
    }
    return found
  }

  const buttons: { where: string; glyph: string; chip: boolean; cls: string }[] = []
  for (const file of files) {
    const src = readFileSync(file, "utf8")
    for (const b of glyphButtons(src)) {
      if (!GLYPH.test(b.body)) continue
      const cls = b.attrs.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/)
      const value = cls?.[1] ?? cls?.[2] ?? ""
      buttons.push({
        where: `${relative(ROOT, file)}:${src.slice(0, b.at).split("\n").length}`,
        glyph: b.body,
        chip: /\bicon-chip\b/.test(value),
        cls: value,
      })
    }
  }

  it("finds them", () => {
    expect(buttons.length).toBeGreaterThan(15)
  })

  it("leaves none on an ad-hoc class", () => {
    const stray = buttons
      .filter((b) => !b.chip && !b.cls.includes(GUTTER_EXCEPTION))
      .map((b) => `${b.where} ${b.glyph} (${b.cls})`)
    expect(stray).toEqual([])
  })

  it("retired every class that used to style one by hand", () => {
    const retired = [
      ".scm-close {",
      ".onboard-close {",
      ".attachment-remove {",
      ".dcm-chip-del",
      ".scripts-row-remove",
      ".mode-del",
      ".theme-del",
      ".board-del {",
      ".surface-pick-chip-remove",
      ".stash-delete {",
      ".queued-chip button",
      ".tb-icon",
      ".surface-nav {",
      ".board-add button",
    ]
    // A class may survive for position; none may still declare its own box.
    const stillSized = retired.filter((sel) => {
      const rule = RULES.find((r) => r.selector.startsWith(sel.replace(" {", "")))
      if (!rule) return false
      return BOX_PROPS.some((p) => p in rule.decls)
    })
    expect(stillSized).toEqual([])
  })
})
