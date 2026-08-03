import { describe, expect, it } from "vitest"
import { readableFailure } from "../src/main/provider-probe"

describe("readableFailure", () => {
  it("pulls the sentence out of a claude result line", () => {
    // Verified against claude 2.1.205 with a logged-out CLI.
    const raw =
      '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","num_turns":1}'
    expect(readableFailure(raw)).toBe("Not logged in · Please run /login")
  })

  it("reads a nested error message", () => {
    expect(readableFailure('{"error":{"message":"rate limited"}}')).toBe("rate limited")
  })

  it("skips banner lines before the JSON", () => {
    expect(
      readableFailure('Loading config...\n{"message":"quota exceeded"}'),
    ).toBe("quota exceeded")
  })

  it("returns null for plain text so the caller falls back to the tail", () => {
    expect(readableFailure("command not found: claude")).toBeNull()
    expect(readableFailure("")).toBeNull()
  })
})
