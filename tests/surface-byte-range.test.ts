import { describe, expect, it } from "vitest"
import { parseByteRange } from "../src/main/surfaces/byte-range"

const SIZE = 7652

describe("byte range parsing", () => {
  it("reads a closed range", () => {
    expect(parseByteRange("bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 })
    expect(parseByteRange("bytes=100-199", SIZE)).toEqual({
      start: 100,
      end: 199,
    })
  })

  it("runs an open range to the last byte", () => {
    expect(parseByteRange("bytes=7600-", SIZE)).toEqual({
      start: 7600,
      end: SIZE - 1,
    })
  })

  it("reads a suffix range from the end", () => {
    expect(parseByteRange("bytes=-52", SIZE)).toEqual({
      start: SIZE - 52,
      end: SIZE - 1,
    })
    expect(parseByteRange("bytes=-99999", SIZE)).toEqual({
      start: 0,
      end: SIZE - 1,
    })
  })

  it("clamps an end past the last byte", () => {
    expect(parseByteRange("bytes=7600-99999", SIZE)).toEqual({
      start: 7600,
      end: SIZE - 1,
    })
  })

  it("gives up rather than claim a range it cannot honour", () => {
    expect(parseByteRange(null, SIZE)).toBeNull()
    expect(parseByteRange("bytes=99999-", SIZE)).toBeNull()
    expect(parseByteRange("bytes=200-100", SIZE)).toBeNull()
    expect(parseByteRange("bytes=-", SIZE)).toBeNull()
    expect(parseByteRange("bytes=-0", SIZE)).toBeNull()
    expect(parseByteRange("bytes=0-99,200-299", SIZE)).toBeNull()
    expect(parseByteRange("items=0-99", SIZE)).toBeNull()
    expect(parseByteRange("bytes=0-99", 0)).toBeNull()
  })
})
