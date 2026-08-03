import { describe, expect, it } from "vitest"
import { fuzzyScore } from "@renderer/lib/fuzzy"

describe("fuzzyScore (⌘K switcher ranking)", () => {
  it("matches an ordered subsequence and rejects the wrong order", () => {
    expect(fuzzyScore("auth", "Refactor auth middleware")).not.toBeNull()
    expect(fuzzyScore("htua", "Refactor auth middleware")).toBeNull()
  })

  it("rejects a query with a character the label does not have", () => {
    expect(fuzzyScore("zzz", "Refactor auth middleware")).toBeNull()
  })

  it("is case-insensitive and ignores spaces in the query", () => {
    expect(fuzzyScore("AUTH MID", "Refactor auth middleware")).not.toBeNull()
  })

  it("ranks a contiguous match above a scattered one", () => {
    const label = "Fix webhook retries proxy-flash-admin"
    const tight = fuzzyScore("webhook", label)
    const spread = fuzzyScore("fxrpa", label)
    expect(tight).not.toBeNull()
    expect(spread).not.toBeNull()
    expect(tight as number).toBeGreaterThan(spread as number)
  })

  it("rewards a word start over the same letter buried mid-word", () => {
    const wordStart = fuzzyScore("r", "fix retries")
    const buried = fuzzyScore("r", "fix boring")
    expect(wordStart).not.toBeNull()
    expect(buried).not.toBeNull()
    expect(wordStart as number).toBeGreaterThan(buried as number)
  })

  it("keeps every session listed while the query is empty", () => {
    expect(fuzzyScore("", "anything")).toBe(0)
    expect(fuzzyScore("   ", "anything")).toBe(0)
  })
})
