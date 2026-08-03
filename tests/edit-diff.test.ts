import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { buildEditDiff, diffLines } from "../src/main/adapters/edit-diff"
import { toolUseBlock } from "../src/main/adapters/stream-parse"
import { buildTranscript } from "@renderer/lib/tool-runs"
import { parseDiff, wordRanges } from "@renderer/lib/diff-view"
import { highlight, languageOf, styleLine } from "@renderer/lib/syntax"

function scratch(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-hub-diff-"))
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

const FILE = [
  "import { decode } from './decode'",
  "",
  "export function verifyJwt(token: string) {",
  "  const claims = decode(token)",
  "  if (!claims) return null",
  "  if (claims.iat < Date.now() / 1000) return null",
  "  return claims",
  "}",
  "",
].join("\n")

describe("diffLines", () => {
  it("keeps the untouched lines as context instead of re-adding them", () => {
    const ops = diffLines(["a", "b", "c"], ["a", "B", "c"])
    expect(ops).toEqual([
      { kind: " ", text: "a" },
      { kind: "-", text: "b" },
      { kind: "+", text: "B" },
      { kind: " ", text: "c" },
    ])
  })

  it("treats an empty side as a pure insert or delete", () => {
    expect(diffLines([], ["x"])).toEqual([{ kind: "+", text: "x" }])
    expect(diffLines(["x"], [])).toEqual([{ kind: "-", text: "x" }])
  })
})

describe("buildEditDiff", () => {
  it("numbers the hunk from the real file when it can find the old text", () => {
    const path = scratch("jwt.ts", FILE)
    const diff = buildEditDiff(path, [
      {
        oldText: "  if (claims.iat < Date.now() / 1000) return null",
        newText: "  if (claims.exp <= Date.now() / 1000) return null",
      },
    ])
    expect(diff.absoluteLines).toBe(true)
    expect(diff.text).toContain("@@ -6,1 +6,1 @@")
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
  })

  it("says the numbers are relative when the file is not on disk", () => {
    const diff = buildEditDiff("/nope/missing.ts", [
      { oldText: "a", newText: "b" },
    ])
    expect(diff.absoluteLines).toBe(false)
    expect(diff.text).toContain("@@ -1,1 +1,1 @@")
  })

  it("calls a Write's own line numbers absolute — the content IS the file", () => {
    const diff = buildEditDiff("/anywhere/new.ts", [
      { oldText: "", newText: "one\ntwo\n" },
    ])
    expect(diff.absoluteLines).toBe(true)
    expect(diff.text).toContain("@@ -1,0 +1,2 @@")
    expect(diff.added).toBe(2)
    expect(diff.removed).toBe(0)
  })

  it("never reads git — a folder outside a repo still gets a diff", () => {
    const path = scratch("plain.txt", "one\ntwo\nthree\n")
    const diff = buildEditDiff(path, [{ oldText: "two", newText: "TWO" }])
    expect(diff.text).toContain("- two")
    expect(diff.text).toContain("+ TWO")
    expect(diff.absoluteLines).toBe(true)
  })

  it("gives a multi-edit call one hunk per edit, each placed in the file", () => {
    const path = scratch("jwt.ts", FILE)
    const diff = buildEditDiff(path, [
      {
        oldText: "import { decode } from './decode'",
        newText: "import { decode } from './decode'\nimport { now } from './clock'",
      },
      {
        oldText: "  if (claims.iat < Date.now() / 1000) return null",
        newText: "  if (claims.exp <= now()) return null",
      },
    ])
    const headers = diff.text.match(/@@ [^@]+@@/g) ?? []
    expect(headers).toHaveLength(2)
    expect(headers[0]).toContain("-1,")
    // The second edit is located after the first one lengthened the file.
    expect(headers[1]).toContain("-7,")
    expect(diff.absoluteLines).toBe(true)
  })

  it("carries the absolute-lines flag through to the rendered card", () => {
    const path = scratch("jwt.ts", FILE)
    const out = toolUseBlock("Edit", {
      file_path: path,
      old_string: "  return claims",
      new_string: "  return claims as Claims",
    })
    const [call] = (buildTranscript(out).blocks[0] as { calls: unknown[] })
      .calls as { meta: { absLines?: true } }[]
    expect(call!.meta.absLines).toBe(true)
  })
})

describe("parseDiff", () => {
  const diff = [
    "@@ -12,4 +12,5 @@",
    "  const claims = decode(token)",
    "-   if (claims.iat < now) return null",
    "+   const seconds = Math.floor(now)",
    "+   if (claims.exp <= seconds) return null",
    "  return claims",
  ].join("\n")

  it("numbers old and new sides independently from the hunk header", () => {
    const { hunks } = parseDiff(diff)
    expect(hunks).toHaveLength(1)
    const rows = hunks[0]!.rows
    expect(rows.map((r) => [r.kind, r.oldLine, r.newLine])).toEqual([
      ["context", 12, 12],
      ["del", 13, null],
      ["add", null, 13],
      ["add", null, 14],
      ["context", 14, 15],
    ])
  })

  it("counts the changed lines and splits several hunks", () => {
    const two = `${diff}\n@@ -40,1 +41,1 @@\n- old\n+ new`
    const parsed = parseDiff(two)
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.added).toBe(3)
    expect(parsed.removed).toBe(2)
    expect(parsed.hunks[1]!.oldStart).toBe(40)
  })

  it("marks the truncation note instead of rendering it as a line", () => {
    const parsed = parseDiff("@@ -1,1 +1,1 @@\n- a\n+ b\n… (7 more lines)")
    expect(parsed.truncated).toBe(true)
    expect(parsed.hunks[0]!.rows).toHaveLength(2)
  })

  it("leaves a rewritten line whole rather than lighting up half its words", () => {
    // 1 removed / 2 added: pairing blindly by index would mark almost every
    // token of two lines that merely share `Date.now() / 1000`.
    const parsed = parseDiff(
      [
        "@@ -1,1 +1,2 @@",
        "-   if (claims.iat < Date.now() / 1000) return null",
        "+   const seconds = Math.floor(Date.now() / 1000)",
        "+   if (claims.exp <= seconds) return null",
      ].join("\n"),
    )
    const rows = parsed.hunks[0]!.rows
    const marks = (row: (typeof rows)[number]) =>
      row.changed.map(([s, e]) => row.text.slice(s, e))
    // The wholly new line stays plain; the removed line is paired with the one
    // that really is its rewrite, two rows down.
    expect(marks(rows[1]!)).toEqual([])
    expect(marks(rows[0]!)).toContain("iat")
    expect(marks(rows[2]!)).toContain("exp")
    expect(marks(rows[2]!)).toContain("seconds")
  })

  it("highlights only the bytes that differ between a paired -/+ line", () => {
    const parsed = parseDiff(
      '@@ -1,1 +1,1 @@\n- export function buildTranscript(src: string) {\n+ export function buildTranscript(src: string, scope = "") {',
    )
    const [del, add] = parsed.hunks[0]!.rows
    const marked = add!.changed.map(([s, e]) => add!.text.slice(s, e).trim())
    expect(marked.join("")).toContain("scope")
    expect(del!.changed).toEqual([])
  })
})

describe("wordRanges", () => {
  it("finds a single changed token in the middle of a line", () => {
    const { left, right } = wordRanges("if (claims.iat < n)", "if (claims.exp < n)")
    expect(left.map(([s, e]) => "if (claims.iat < n)".slice(s, e))).toEqual([
      "iat",
    ])
    expect(right.map(([s, e]) => "if (claims.exp < n)".slice(s, e))).toEqual([
      "exp",
    ])
  })

  it("reports nothing when the lines are identical", () => {
    expect(wordRanges("same", "same")).toEqual({ left: [], right: [] })
  })

  it("handles a pure append at the end of the line", () => {
    const after = "const a = 1 // note"
    const { left, right } = wordRanges("const a = 1", after)
    expect(left).toEqual([])
    expect(right.map(([s, e]) => after.slice(s, e))).toEqual(["// note"])
  })
})

describe("syntax", () => {
  it("picks the language from the file extension", () => {
    expect(languageOf("/p/src/a.tsx")).toBe("js")
    expect(languageOf("/p/main.py")).toBe("py")
    expect(languageOf("/p/App.swift")).toBe("swift")
    expect(languageOf("/p/run.sh")).toBe("sh")
    expect(languageOf("/p/LICENSE")).toBe("text")
  })

  it("classifies keywords, strings, numbers and comments", () => {
    const line = 'const x = "hi" // 42'
    const spans = highlight(line, "js")
    const at = (needle: string) =>
      spans.find((s) => line.slice(s.start, s.end) === needle)?.cls
    expect(at("const")).toBe("keyword")
    expect(at('"hi"')).toBe("string")
    expect(spans.some((s) => s.cls === "comment")).toBe(true)
  })

  it("keeps a comment marker inside a string out of the comment class", () => {
    const line = 'const url = "https://example.com"'
    const spans = highlight(line, "js")
    expect(spans.some((s) => s.cls === "comment")).toBe(false)
  })

  it("splits a line into pieces that carry both syntax and changed-ness", () => {
    const line = "const b = 22"
    const pieces = styleLine(line, "js", [[10, 12]])
    expect(pieces.map((p) => p.text).join("")).toBe(line)
    expect(pieces.find((p) => p.text === "const")?.cls).toBe("keyword")
    expect(pieces.filter((p) => p.changed).map((p) => p.text)).toEqual(["22"])
  })
})
