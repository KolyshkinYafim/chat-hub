import { describe, expect, it, vi } from "vitest"
import {
  beginAssistant,
  extractTextFromContent,
  extractTouchedFiles,
  finishTurn,
  pushDelta,
  safeJson,
  toolUseBlock,
  touchedFileFromTool,
} from "../src/main/adapters/stream-parse"
import type { AdapterCallbacks } from "../src/main/adapters/types"

function callbacks() {
  return {
    onSessionEvent: vi.fn(),
    onMessage: vi.fn(),
    onDelta: vi.fn(),
    onStreamDone: vi.fn(),
    onAgentSession: vi.fn(),
  } satisfies AdapterCallbacks
}

describe("safeJson", () => {
  it("parses an object line", () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 })
  })

  it("returns null for garbage, scalars and half-written lines", () => {
    // A CLI killed mid-write leaves a truncated line in the stream.
    expect(safeJson('{"a":')).toBeNull()
    expect(safeJson("42")).toBeNull()
    expect(safeJson('"text"')).toBeNull()
    expect(safeJson("")).toBeNull()
  })

  it("returns null for a JSON array (callers index by key)", () => {
    expect(safeJson("[1,2]")).toBeNull()
  })
})

describe("turn lifecycle", () => {
  it("streams deltas and emits one bridge preview at the end", () => {
    const cb = callbacks()
    const turn = beginAssistant("s1", cb)

    expect(cb.onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", streaming: true, content: "" }),
    )

    pushDelta(turn, "s1", "Hello ", cb)
    pushDelta(turn, "s1", "world", cb)
    const text = finishTurn(turn, "s1", cb)

    expect(text).toBe("Hello world")
    expect(cb.onDelta).toHaveBeenCalledTimes(2)
    expect(cb.onStreamDone).toHaveBeenCalledWith("s1", turn.messageId)
    expect(cb.onSessionEvent).toHaveBeenCalledWith({
      type: "session.message",
      id: "s1",
      role: "assistant",
      preview: "Hello world",
    })
  })

  it("ignores empty deltas so the transcript does not churn", () => {
    const cb = callbacks()
    const turn = beginAssistant("s1", cb)
    pushDelta(turn, "s1", "", cb)
    expect(cb.onDelta).not.toHaveBeenCalled()
  })

  it("collapses whitespace and caps the bridge preview at 160 chars", () => {
    const cb = callbacks()
    const turn = beginAssistant("s1", cb)
    pushDelta(turn, "s1", `line one\n\n   line two ${"x".repeat(300)}`, cb)
    finishTurn(turn, "s1", cb)

    const [event] = cb.onSessionEvent.mock.calls[0]
    expect(event.preview).toHaveLength(160)
    expect(event.preview.startsWith("line one line two")).toBe(true)
  })

  it("emits no bridge preview for a whitespace-only turn", () => {
    const cb = callbacks()
    const turn = beginAssistant("s1", cb)
    pushDelta(turn, "s1", "   \n ", cb)
    finishTurn(turn, "s1", cb)
    expect(cb.onSessionEvent).not.toHaveBeenCalled()
    expect(cb.onStreamDone).toHaveBeenCalledOnce()
  })

  it("tolerates a null turn (result line before any assistant block)", () => {
    const cb = callbacks()
    expect(finishTurn(null, "s1", cb)).toBe("")
    expect(cb.onStreamDone).not.toHaveBeenCalled()
  })
})

describe("extractTextFromContent", () => {
  it("passes a plain string through", () => {
    expect(extractTextFromContent("hi")).toBe("hi")
  })

  it("returns empty for null/undefined/object content", () => {
    expect(extractTextFromContent(null)).toBe("")
    expect(extractTextFromContent(undefined)).toBe("")
    expect(extractTextFromContent({ type: "text" })).toBe("")
  })

  it("joins text blocks and skips unknown block types", () => {
    const out = extractTextFromContent([
      { type: "text", text: "a" },
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "b" },
      null,
      "not-a-block",
    ])
    expect(out).toBe("ab")
  })

  it("renders tool_use as a tool card", () => {
    const out = extractTextFromContent([
      { type: "tool_use", name: "Bash", input: { command: "npm test\n--watch" } },
    ])
    expect(out).toContain("```tool:Bash")
    expect(out).toContain("$ npm test")
    // Only the first line of a multi-line command lands in the card head.
    expect(out).not.toContain("--watch")
  })

  it("keeps a long result readable but bounded, and says what it dropped", () => {
    // The card collapses long output in the UI, so the cap is about not
    // persisting a megabyte per turn — 500 chars used to cut off the answer
    // itself, which is the one thing the reader opened the card for.
    const out = extractTextFromContent([
      { type: "tool_result", name: "Bash", content: "y".repeat(9000) },
    ])
    expect(out).toContain("```tool-result:Bash")
    expect(out).toContain("y".repeat(8000))
    expect(out).not.toContain("y".repeat(8001))
    expect(out).toContain("… (1000 more characters)")
  })

  it("leaves a result under the cap untouched", () => {
    const out = extractTextFromContent([
      { type: "tool_result", name: "Bash", content: "2 passed" },
    ])
    expect(out).toContain("```tool-result:Bash\n2 passed\n```")
  })

  it("labels an unnamed tool_result 'result'", () => {
    const out = extractTextFromContent([{ type: "tool_result", content: "ok" }])
    expect(out).toContain("```tool-result:result")
  })
})

describe("toolUseBlock", () => {
  it("makes a diff for Edit", () => {
    const out = toolUseBlock("Edit", {
      file_path: "/p/auth.ts",
      old_string: "a",
      new_string: "b",
    })
    expect(out).toContain("```tool:Edit")
    expect(out).toContain("/p/auth.ts")
    expect(out).toContain("```diff")
    expect(out).toContain("- a")
    expect(out).toContain("+ b")
  })

  it("treats Write as an all-additions diff", () => {
    const out = toolUseBlock("Write", { file_path: "/p/new.ts", content: "x\ny" })
    expect(out).toContain("+ x")
    expect(out).toContain("+ y")
    expect(out).not.toContain("- ")
  })

  it("summarises MultiEdit with an edit count", () => {
    const out = toolUseBlock("MultiEdit", {
      file_path: "/p/a.ts",
      edits: [
        { old_string: "1", new_string: "2" },
        { old_string: "3", new_string: "4" },
      ],
    })
    expect(out).toContain("/p/a.ts · 2 edits")
    expect(out).toContain("- 1")
    expect(out).toContain("+ 4")
  })

  it("truncates a huge diff instead of flooding the transcript", () => {
    const out = toolUseBlock("Write", {
      file_path: "/p/big.ts",
      content: Array.from({ length: 900 }, (_, i) => `l${i}`).join("\n"),
    })
    expect(out).toMatch(/… \(\d+ more lines\)/)
    const diff = /```diff\n([\s\S]*?)\n```/.exec(out)?.[1] ?? ""
    expect(diff.split("\n").length).toBeLessThanOrEqual(402)
  })

  it("is case-insensitive about tool names (str_replace variants)", () => {
    const out = toolUseBlock("str_replace_editor", { old_string: "a", new_string: "b" })
    expect(out).toContain("- a")
    expect(out).toContain("+ b")
  })

  it("falls back to compact JSON, then to (no args)", () => {
    expect(toolUseBlock("Weird", { q: 1 })).toContain('{"q":1}')
    expect(toolUseBlock("Weird", {})).toContain("(no args)")
    expect(toolUseBlock("Weird", undefined)).toContain("(no args)")
  })
})

describe("touchedFileFromTool", () => {
  it("reports the file for write/edit/multiedit/str_replace calls", () => {
    expect(touchedFileFromTool("Write", { file_path: "/a.ts" })).toBe("/a.ts")
    expect(touchedFileFromTool("Edit", { file_path: "/b.ts" })).toBe("/b.ts")
    expect(touchedFileFromTool("MultiEdit", { file_path: "/c.ts" })).toBe("/c.ts")
    expect(
      touchedFileFromTool("str_replace_editor", { path: "/d.ts" }),
    ).toBe("/d.ts")
  })

  it("falls back to path/notebook_path when file_path is absent", () => {
    expect(touchedFileFromTool("Write", { path: "/a.ts" })).toBe("/a.ts")
    expect(
      touchedFileFromTool("Edit", { notebook_path: "/n.ipynb" }),
    ).toBe("/n.ipynb")
  })

  it("is undefined for reads, searches, and any non-editing tool", () => {
    expect(touchedFileFromTool("Read", { file_path: "/a.ts" })).toBeUndefined()
    expect(touchedFileFromTool("Bash", { command: "ls" })).toBeUndefined()
    expect(touchedFileFromTool("Grep", { pattern: "x" })).toBeUndefined()
    expect(touchedFileFromTool("Glob", { pattern: "*.ts" })).toBeUndefined()
  })

  it("is undefined when an editing tool carries no file field", () => {
    expect(touchedFileFromTool("Write", {})).toBeUndefined()
    expect(touchedFileFromTool("Edit", undefined)).toBeUndefined()
  })
})

describe("extractTouchedFiles", () => {
  it("collects files from write/edit/multiedit tool_use blocks only", () => {
    const files = extractTouchedFiles([
      { type: "text", text: "doing stuff" },
      { type: "tool_use", name: "Read", input: { file_path: "/ignored.ts" } },
      { type: "tool_use", name: "Write", input: { file_path: "/a.ts" } },
      {
        type: "tool_use",
        name: "MultiEdit",
        input: { file_path: "/b.ts", edits: [] },
      },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ])
    expect(files).toEqual(["/a.ts", "/b.ts"])
  })

  it("dedupes a file touched by more than one tool call", () => {
    const files = extractTouchedFiles([
      { type: "tool_use", name: "Edit", input: { file_path: "/a.ts" } },
      { type: "tool_use", name: "Edit", input: { file_path: "/a.ts" } },
    ])
    expect(files).toEqual(["/a.ts"])
  })

  it("returns empty for non-array, null, and malformed content", () => {
    expect(extractTouchedFiles("plain string")).toEqual([])
    expect(extractTouchedFiles(null)).toEqual([])
    expect(extractTouchedFiles(undefined)).toEqual([])
    expect(
      extractTouchedFiles([null, "not-a-block", { type: "tool_use" }]),
    ).toEqual([])
  })
})
