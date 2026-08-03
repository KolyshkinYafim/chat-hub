import { describe, expect, it } from "vitest"
import {
  extractTouchedFiles,
  touchedFileFromTool,
} from "../src/main/adapters/stream-parse"

describe("touchedFileFromTool", () => {
  it("reports the path for write/edit/multiedit calls", () => {
    expect(touchedFileFromTool("write", { file_path: "/a.ts" })).toBe(
      "/a.ts",
    )
    expect(touchedFileFromTool("edit", { file_path: "/b.ts" })).toBe("/b.ts")
    expect(touchedFileFromTool("multiedit", { file_path: "/c.ts" })).toBe(
      "/c.ts",
    )
    expect(touchedFileFromTool("str_replace_editor", { path: "/d.ts" })).toBe(
      "/d.ts",
    )
  })

  it("ignores reads and other non-mutating tools", () => {
    expect(touchedFileFromTool("read", { file_path: "/a.ts" })).toBeUndefined()
    expect(touchedFileFromTool("bash", { command: "ls" })).toBeUndefined()
    expect(touchedFileFromTool("grep", { pattern: "foo" })).toBeUndefined()
  })
})

describe("extractTouchedFiles", () => {
  it("collects write/edit/multiedit paths from a content array", () => {
    const content = [
      { type: "text", text: "editing now" },
      { type: "tool_use", name: "write", input: { file_path: "/a.ts" } },
      { type: "tool_use", name: "read", input: { file_path: "/ignored.ts" } },
      { type: "tool_use", name: "edit", input: { file_path: "/b.ts" } },
    ]
    expect(extractTouchedFiles(content)).toEqual(["/a.ts", "/b.ts"])
  })

  it("dedupes repeated paths across multiple tool calls in one message", () => {
    const content = [
      { type: "tool_use", name: "edit", input: { file_path: "/a.ts" } },
      { type: "tool_use", name: "multiedit", input: { file_path: "/a.ts" } },
      { type: "tool_use", name: "write", input: { file_path: "/b.ts" } },
    ]
    expect(extractTouchedFiles(content)).toEqual(["/a.ts", "/b.ts"])
  })

  it("returns an empty list for read-only turns", () => {
    const content = [
      { type: "tool_use", name: "read", input: { file_path: "/a.ts" } },
      { type: "tool_use", name: "grep", input: { pattern: "foo" } },
    ]
    expect(extractTouchedFiles(content)).toEqual([])
  })

  it("returns an empty list for non-array content", () => {
    expect(extractTouchedFiles("just text")).toEqual([])
    expect(extractTouchedFiles(undefined)).toEqual([])
  })
})
