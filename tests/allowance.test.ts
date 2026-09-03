import { describe, expect, it } from "vitest"
import {
  allowanceTitle,
  allowanceWindows,
  formatQuotaChip,
  quotaChipTitle,
  reachedLabel,
  windowLabel,
} from "@renderer/lib/allowance"

describe("formatQuotaChip", () => {
  it("renders both windows compactly", () => {
    expect(
      formatQuotaChip({
        primaryUsed: 0.584,
        primaryWindowMins: 300,
        secondaryUsed: 0.412,
        secondaryWindowMins: 10080,
      }),
    ).toBe("58% 5h · 41% wk")
  })

  it("renders a lone primary window", () => {
    expect(formatQuotaChip({ primaryUsed: 0.07, primaryWindowMins: 300 })).toBe(
      "7% 5h",
    )
  })

  it("omits the label when the window length is unknown", () => {
    expect(formatQuotaChip({ primaryUsed: 0.5 })).toBe("50%")
  })

  it("returns null when nothing was reported", () => {
    expect(formatQuotaChip(null)).toBeNull()
    expect(formatQuotaChip(undefined)).toBeNull()
    expect(formatQuotaChip({})).toBeNull()
  })

  it("falls back to the reached notice when only that arrived", () => {
    expect(formatQuotaChip({ reached: "weekly_limit" })).toBe("limit reached")
  })

  it("rounds to whole percent and clamps negatives", () => {
    expect(formatQuotaChip({ primaryUsed: 0.005, primaryWindowMins: 60 })).toBe(
      "1% 1h",
    )
    expect(formatQuotaChip({ primaryUsed: -0.2, primaryWindowMins: 60 })).toBe(
      "0% 1h",
    )
    expect(formatQuotaChip({ primaryUsed: 1.2, primaryWindowMins: 60 })).toBe(
      "120% 1h",
    )
  })

  it("guards against a non-finite fraction", () => {
    expect(formatQuotaChip({ primaryUsed: Number.NaN })).toBe("0%")
  })

  it("labels day and multi-week windows", () => {
    expect(formatQuotaChip({ primaryUsed: 0.3, primaryWindowMins: 1440 })).toBe(
      "30% d",
    )
    expect(
      formatQuotaChip({ primaryUsed: 0.3, primaryWindowMins: 20160 }),
    ).toBe("30% 2w")
    expect(formatQuotaChip({ primaryUsed: 0.3, primaryWindowMins: 90 })).toBe(
      "30% 90m",
    )
  })
})

describe("windowLabel", () => {
  it("prefers the largest clean unit", () => {
    expect(windowLabel(10080)).toBe("1w")
    expect(windowLabel(2880)).toBe("2d")
    expect(windowLabel(300)).toBe("5h")
    expect(windowLabel(45)).toBe("45m")
    expect(windowLabel(undefined)).toBe("window")
  })
})

describe("allowanceWindows", () => {
  it("keeps only the windows the provider reported", () => {
    expect(allowanceWindows({})).toEqual([])
    expect(
      allowanceWindows({ secondaryUsed: 0.9, secondaryWindowMins: 10080 }),
    ).toEqual([{ used: 0.9, mins: 10080, resets: undefined }])
  })
})

describe("quotaChipTitle", () => {
  it("spells out the windows and the reached notice", () => {
    const title = quotaChipTitle({
      primaryUsed: 0.58,
      primaryWindowMins: 300,
      reached: "weekly_limit",
    })
    expect(title).toContain("weekly limit")
    expect(title).toContain("58% of the 5h allowance used")
  })

  it("returns null with nothing to say", () => {
    expect(quotaChipTitle({})).toBeNull()
    expect(quotaChipTitle(null)).toBeNull()
  })
})

describe("allowanceTitle / reachedLabel", () => {
  it("includes the reset time when known", () => {
    const resets = Date.UTC(2026, 0, 5, 12, 0, 0)
    expect(allowanceTitle({ used: 0.5, mins: 300, resets })).toContain(
      "resets",
    )
    expect(allowanceTitle({ used: 0.5, mins: 300 })).toBe(
      "50% of the 5h allowance used",
    )
  })

  it("humanizes the provider's reached code", () => {
    expect(reachedLabel("weekly_limit_reached")).toBe("weekly limit reached")
  })
})
