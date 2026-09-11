import { describe, expect, it } from "vitest"
import {
  clearBrowserUrl,
  lastBrowserUrl,
  peekBrowserUrl,
  prunePendingRuns,
  rememberBrowserUrl,
  stashBrowserUrl,
} from "../src/renderer/src/lib/pending-run"

describe("browser url memory", () => {
  it("keeps the last visited url per session across surface remounts", () => {
    rememberBrowserUrl("s1", "http://localhost:5180/")
    rememberBrowserUrl("s2", "http://example.com/")
    expect(lastBrowserUrl("s1")).toBe("http://localhost:5180/")
    expect(lastBrowserUrl("s2")).toBe("http://example.com/")
    expect(lastBrowserUrl("s3")).toBeNull()
  })

  it("is independent of the one-shot pending handoff", () => {
    stashBrowserUrl("s1", "http://localhost:4000/")
    expect(peekBrowserUrl("s1")).toBe("http://localhost:4000/")
    clearBrowserUrl("s1")
    expect(peekBrowserUrl("s1")).toBeNull()
    expect(lastBrowserUrl("s1")).toBe("http://localhost:5180/")
  })

  it("forgets sessions that are gone", () => {
    prunePendingRuns(new Set(["s2"]))
    expect(lastBrowserUrl("s1")).toBeNull()
    expect(lastBrowserUrl("s2")).toBe("http://example.com/")
  })
})
