import { describe, expect, it } from "vitest"
import {
  hashDiff,
  isViewed,
  reconcileViewed,
  withoutViewed,
  withViewed,
  type ViewedMap,
} from "../src/renderer/src/lib/diff-viewed"

const DIFF_A = "@@ -1,2 +1,2 @@\n-old\n+new\n"
const DIFF_B = "@@ -1,2 +1,3 @@\n-old\n+new\n+newer\n"

describe("hashDiff", () => {
  it("is stable for identical content", () => {
    expect(hashDiff(DIFF_A)).toBe(hashDiff(DIFF_A))
  })

  it("changes when the diff changes", () => {
    expect(hashDiff(DIFF_A)).not.toBe(hashDiff(DIFF_B))
    expect(hashDiff("")).not.toBe(hashDiff(DIFF_A))
  })

  it("returns eight hex characters", () => {
    expect(hashDiff(DIFF_A)).toMatch(/^[0-9a-f]{8}$/)
    expect(hashDiff("")).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("viewed map", () => {
  it("marks and unmarks without mutating the input", () => {
    const empty: ViewedMap = {}
    const marked = withViewed(empty, "w:src/a.ts", hashDiff(DIFF_A))
    expect(empty).toEqual({})
    expect(marked["w:src/a.ts"]).toBe(hashDiff(DIFF_A))
    const cleared = withoutViewed(marked, "w:src/a.ts")
    expect(marked["w:src/a.ts"]).toBe(hashDiff(DIFF_A))
    expect(cleared).toEqual({})
  })

  it("keeps the same reference for a no-op change", () => {
    const marked = withViewed({}, "w:src/a.ts", hashDiff(DIFF_A))
    expect(withViewed(marked, "w:src/a.ts", hashDiff(DIFF_A))).toBe(marked)
    expect(withoutViewed(marked, "w:src/other.ts")).toBe(marked)
  })

  it("treats a file as viewed only while the hash matches", () => {
    const marked = withViewed({}, "w:src/a.ts", hashDiff(DIFF_A))
    expect(isViewed(marked, "w:src/a.ts", hashDiff(DIFF_A))).toBe(true)
    expect(isViewed(marked, "w:src/a.ts", hashDiff(DIFF_B))).toBe(false)
    expect(isViewed(marked, "s:src/a.ts", hashDiff(DIFF_A))).toBe(false)
  })
})

describe("reconcileViewed", () => {
  it("drops an entry whose diff content changed", () => {
    const marked = withViewed({}, "w:src/a.ts", hashDiff(DIFF_A))
    const next = reconcileViewed(marked, { "w:src/a.ts": hashDiff(DIFF_B) })
    expect(next).toEqual({})
  })

  it("drops an entry whose file no longer has a diff", () => {
    const marked = withViewed({}, "w:src/gone.ts", hashDiff(DIFF_A))
    expect(reconcileViewed(marked, {})).toEqual({})
  })

  it("keeps matching entries and returns the same reference unchanged", () => {
    const map = withViewed(
      withViewed({}, "w:src/a.ts", hashDiff(DIFF_A)),
      "s:src/b.ts",
      hashDiff(DIFF_B),
    )
    const current: ViewedMap = {
      "w:src/a.ts": hashDiff(DIFF_A),
      "s:src/b.ts": hashDiff(DIFF_B),
    }
    expect(reconcileViewed(map, current)).toBe(map)
    const partial = reconcileViewed(map, {
      "w:src/a.ts": hashDiff(DIFF_A),
      "s:src/b.ts": hashDiff(DIFF_A),
    })
    expect(partial).toEqual({ "w:src/a.ts": hashDiff(DIFF_A) })
  })
})
