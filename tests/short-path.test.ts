import { describe, expect, it } from "vitest"
import {
  looksLikePath,
  shortenIfPath,
  shortenPath,
  splitPath,
} from "@renderer/lib/short-path"

const DEEP = "/Users/dev/agent-desktop-suite/chat-hub/src/main/adapters/grok.ts"

describe("shortenPath", () => {
  it("drops leading segments, never the file name", () => {
    const short = shortenPath(DEEP, 40)
    expect(short.startsWith("…/")).toBe(true)
    expect(short.endsWith("adapters/grok.ts")).toBe(true)
    expect(short.length).toBeLessThanOrEqual(40)
  })

  it("keeps a path that already fits exactly as it is", () => {
    expect(shortenPath("src/main/adapters/grok.ts", 40)).toBe(
      "src/main/adapters/grok.ts",
    )
  })

  it("tells two files under one long prefix apart", () => {
    const a = shortenPath(`${DEEP.replace("grok.ts", "codex.ts")}`, 30)
    const b = shortenPath(DEEP, 30)
    expect(a).not.toBe(b)
    expect(a.endsWith("codex.ts")).toBe(true)
    expect(b.endsWith("grok.ts")).toBe(true)
  })

  it("cuts an oversized last segment from its own left", () => {
    const short = shortenPath("src/a-very-long-file-name-indeed.ts", 12)
    expect(short).toBe("…e-indeed.ts")
    expect(short.length).toBe(12)
  })

  it("leaves a path with no separator alone when it fits", () => {
    expect(shortenPath("grok.ts", 40)).toBe("grok.ts")
  })
})

describe("splitPath", () => {
  it("splits off the last segment as the part that never shrinks", () => {
    expect(splitPath("src/main/adapters/grok.ts")).toEqual({
      head: "src/main/adapters/",
      tail: "grok.ts",
    })
  })

  it("treats a trailing slash as part of the last segment", () => {
    expect(splitPath("src/main/adapters/")).toEqual({
      head: "src/main/",
      tail: "adapters/",
    })
  })

  it("gives a bare file name no head at all", () => {
    expect(splitPath("grok.ts")).toEqual({ head: "", tail: "grok.ts" })
  })
})

describe("looksLikePath", () => {
  it("accepts a bare path", () => {
    expect(looksLikePath("src/main/adapters/grok.ts")).toBe(true)
    expect(looksLikePath("/etc/hosts")).toBe(true)
  })

  it("rejects prose, urls and empty text", () => {
    expect(looksLikePath("Ran the suite in src/main")).toBe(false)
    expect(looksLikePath("https://example.com/a/b")).toBe(false)
    expect(looksLikePath("")).toBe(false)
  })

  it("leaves a non-path untouched", () => {
    expect(shortenIfPath("pnpm test -- expiry auth", 8)).toBe(
      "pnpm test -- expiry auth",
    )
  })
})
