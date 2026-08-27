import { describe, expect, it } from "vitest"

import { asText, describeValue } from "../src/shared/text"

describe("asText", () => {
  it("passes a string through untouched", () => {
    expect(asText("tool_use")).toBe("tool_use")
    expect(asText("")).toBe("")
  })

  it("spells out the primitives that have one obvious spelling", () => {
    expect(asText(42)).toBe("42")
    expect(asText(0)).toBe("0")
    expect(asText(true)).toBe("true")
    expect(asText(10n)).toBe("10")
  })

  it("refuses a structure rather than answering [object Object]", () => {
    expect(asText({ type: "result" })).toBe("")
    expect(asText(["result"])).toBe("")
    expect(asText(() => "result")).toBe("")
    expect(asText(Symbol("result"))).toBe("")
  })

  it("reads a missing field as empty", () => {
    expect(asText(null)).toBe("")
    expect(asText(undefined)).toBe("")
  })

  it("never produces a value a branch would accept by accident", () => {
    // The bug this helper exists for: a field that arrived as an object used
    // to match `startsWith("[object")` and end up in the wrong branch.
    const surprise: unknown = { subtype: "tool_error" }
    expect(asText(surprise).endsWith("_error")).toBe(false)
    expect(asText(surprise)).not.toContain("object")
  })
})

describe("describeValue", () => {
  it("keeps a string readable, without quoting it", () => {
    expect(describeValue("facts")).toBe("facts")
  })

  it("spells out a structure, because that is the interesting part", () => {
    expect(describeValue({ id: 1 })).toBe('{"id":1}')
    expect(describeValue([1, 2])).toBe("[1,2]")
  })

  it("names the absent cases", () => {
    expect(describeValue(null)).toBe("null")
    expect(describeValue(undefined)).toBe("undefined")
  })

  it("survives a value JSON cannot serialize", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(describeValue(cyclic)).toBe("[object Object]")
    expect(describeValue(10n)).toBe("10")
  })
})
