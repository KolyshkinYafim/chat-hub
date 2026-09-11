import { describe, expect, it } from "vitest"
import { assistantExportText } from "../src/shared/export-text"
import { toolResultBlock, toolUseBlock } from "../src/main/adapters/stream-parse"
describe("assistant trace text", () => {
  it("removes real tool results, nested fences, file edits, and reasoning", () => {
    const text = "Done.\n" + toolResultBlock("read", "private file\n```ts\nsecret\n```\nmore private file") + toolUseBlock("Edit", { file_path: "/private/file", old_string: "private before", new_string: "private after" }) + "```thinking\nprivate reasoning\n```\nTests passed."
    expect(assistantExportText(text)).toBe("Done.\n\nTests passed.")
  })
  it("keeps normal final answer code and markdown", () => {
    const text = "Use this:\n```ts\nconst answer = 42\n```"
    expect(assistantExportText(text)).toBe(text)
  })
  it("excludes unfinished tool output", () => {
    expect(assistantExportText("Summary.\n````tool-result:read\nprivate\n```\nmore")).toBe("Summary.")
  })
})
