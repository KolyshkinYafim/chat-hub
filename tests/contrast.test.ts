import { describe, expect, it } from "vitest"
import {
  colorDifference,
  contrastRatio,
  lightnessGap,
  okLab,
  okLightness,
  parseColorChannels,
  relativeLuminance,
} from "@shared/contrast"

describe("parseColorChannels", () => {
  it("reads every hex form a token may use", () => {
    expect(parseColorChannels("#fff")).toEqual([255, 255, 255])
    expect(parseColorChannels("#88a7fd")).toEqual([136, 167, 253])
    expect(parseColorChannels("#88a7fdcc")).toEqual([136, 167, 253])
  })

  it("reads rgb and rgba", () => {
    expect(parseColorChannels("rgb(1, 2, 3)")).toEqual([1, 2, 3])
    expect(parseColorChannels("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3])
  })

  it("approximates hsl by its lightness", () => {
    expect(parseColorChannels("hsl(210, 40%, 20%)")).toEqual([51, 51, 51])
  })

  it("returns null for anything else", () => {
    expect(parseColorChannels("red")).toBeNull()
    expect(parseColorChannels("var(--bg)")).toBeNull()
  })
})

describe("contrastRatio", () => {
  it("matches the WCAG endpoints", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5)
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5)
  })

  it("is symmetric", () => {
    const a = contrastRatio("#88a7fd", "#1b1c21")
    const b = contrastRatio("#1b1c21", "#88a7fd")
    expect(a).toBeCloseTo(b as number, 10)
  })

  it("agrees with a published figure", () => {
    // #767676 on white is the canonical "exactly AA" grey.
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2)
  })

  it("gives up on an unparseable colour", () => {
    expect(contrastRatio("teal", "#ffffff")).toBeNull()
  })
})

describe("relativeLuminance", () => {
  it("spans black to white", () => {
    expect(relativeLuminance("#000000")).toBe(0)
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10)
  })
})

describe("okLab", () => {
  it("puts white at L 1 with no chroma", () => {
    const [l, a, b] = okLab("#ffffff") as [number, number, number]
    expect(l).toBeCloseTo(1, 3)
    expect(a).toBeCloseTo(0, 3)
    expect(b).toBeCloseTo(0, 3)
  })

  it("orders greys the way the eye does", () => {
    const dark = okLightness("#1b1c21") as number
    const mid = okLightness("#6e7078") as number
    const light = okLightness("#ebecf1") as number
    expect(dark).toBeLessThan(mid)
    expect(mid).toBeLessThan(light)
  })
})

describe("lightnessGap", () => {
  it("separates two surfaces that a contrast ratio calls identical", () => {
    // The old --bg / --bg-sidebar pair: 1.03:1, which says nothing useful.
    const ratio = contrastRatio("#0c0d10", "#101114") as number
    expect(ratio).toBeLessThan(1.05)
    expect(lightnessGap("#0c0d10", "#101114")).toBeLessThan(0.028)
    expect(lightnessGap("#0c0d12", "#131419")).toBeGreaterThan(0.028)
  })

  it("is zero for a colour against itself", () => {
    expect(lightnessGap("#123456", "#123456")).toBe(0)
  })
})

describe("colorDifference", () => {
  it("is zero for a colour against itself", () => {
    expect(colorDifference("#88a7fd", "#88a7fd")).toBe(0)
  })

  it("separates two hues that share a lightness", () => {
    // Same OKLab L, opposite hues: contrast ratio cannot tell them apart.
    expect(contrastRatio("#5dc7cb", "#f48684")).toBeLessThan(1.6)
    expect(colorDifference("#5dc7cb", "#f48684")).toBeGreaterThan(0.2)
  })

  it("gives up on an unparseable colour", () => {
    expect(colorDifference("chartreuse", "#000000")).toBeNull()
  })
})
