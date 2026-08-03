import { describe, expect, it } from "vitest"
import { pickAvailableModel, readableFailure } from "../src/main/provider-probe"

describe("readableFailure", () => {
  it("drops a persisted Codex model after it disappears from the live catalog", () => {
    const models = [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    ]
    expect(pickAvailableModel("gpt-5-codex", models)).toBe("gpt-5.6-sol")
    expect(pickAvailableModel("gpt-5.6-terra", models)).toBe("gpt-5.6-terra")
  })

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
