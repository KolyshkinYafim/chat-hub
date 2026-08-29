/**
 * Colour maths for the theme system: parse a token value, then measure it.
 * The palette is designed against these numbers rather than by eye, and
 * `tests/palette.test.ts` re-measures every built-in theme so a token edit
 * cannot quietly drop text below WCAG AA.
 */

/** WCAG AA for body text under 18pt. */
export const AA_TEXT = 4.5
export const AA_LARGE = 3
/** WCAG AA for icons, borders and other non-text UI. */
export const AA_UI = 3

/**
 * sRGB channels 0-255 for a token value, or null when the value is not one of
 * the forms `isThemeColor` admits. `hsl()` collapses to its lightness — the
 * palette is authored in hex and the approximation only has to keep
 * light/dark classification honest.
 */
export function parseColorChannels(value: string): [number, number, number] | null {
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

export function parseColorAlpha(value: string): number | null {
  if (!parseColorChannels(value)) return null
  const hex = value.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hex) {
    let h = hex[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join("")
    if (h.length === 8) return parseInt(h.slice(6, 8), 16) / 255
    return 1
  }
  const rgb = value.match(
    /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(0|1|0?\.\d{1,4}))?\s*\)$/,
  )
  if (rgb) return rgb[1] === undefined ? 1 : Number(rgb[1])
  const hsl = value.match(
    /^hsla?\(\s*\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(0|1|0?\.\d{1,4}))?\s*\)$/,
  )
  if (hsl) return hsl[1] === undefined ? 1 : Number(hsl[1])
  return 1
}

export function compositeOver(fg: string, backdrop: string): string | null {
  const fc = parseColorChannels(fg)
  const bc = parseColorChannels(backdrop)
  if (!fc || !bc) return null
  const a = parseColorAlpha(fg) ?? 1
  const r = Math.round(fc[0] * a + bc[0] * (1 - a))
  const g = Math.round(fc[1] * a + bc[1] * (1 - a))
  const b = Math.round(fc[2] * a + bc[2] * (1 - a))
  return `rgb(${r}, ${g}, ${b})`
}

function toLinear(channel: number): number {
  const s = channel / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(value: string): number | null {
  const ch = parseColorChannels(value)
  if (!ch) return null
  const [r, g, b] = ch.map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (black/white). */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la === null || lb === null) return null
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * OKLab coordinates, [L, a, b]. Contrast ratio is the wrong tool for two
 * neighbouring greys — it compresses hard at the dark end, so a 1.03 ratio
 * says nothing about whether the edge is visible. OKLab is perceptually even,
 * so one threshold works at both ends of the ramp.
 */
export function okLab(value: string): [number, number, number] | null {
  const ch = parseColorChannels(value)
  if (!ch) return null
  const [r, g, b] = ch.map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** OKLab lightness, 0-1. */
export function okLightness(value: string): number | null {
  return okLab(value)?.[0] ?? null
}

/** How far apart two surfaces sit perceptually; below ~0.028 the edge stops reading. */
export function lightnessGap(a: string, b: string): number | null {
  const la = okLightness(a)
  const lb = okLightness(b)
  if (la === null || lb === null) return null
  return Math.abs(la - lb)
}

/**
 * OKLab ΔE between two colours. Two roles that must never be confused for one
 * another — a status dot and a link, say — need distance here, not just a
 * contrast ratio against the background they share.
 */
export function colorDifference(a: string, b: string): number | null {
  const la = okLab(a)
  const lb = okLab(b)
  if (!la || !lb) return null
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2])
}
