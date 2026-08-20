import { describe, expect, it } from "vitest"
import { blocksToPlainText, messageToPlainText } from "@renderer/lib/copy-text"
import { splitBlocks } from "@renderer/lib/markdown"
import { styleBlock } from "@renderer/lib/syntax"

function roundTrip(src: string): string {
  return blocksToPlainText(splitBlocks(src)).trimEnd()
}

describe("copying a message back as markdown", () => {
  it("gives a table back column-padded, not as the DOM read it", () => {
    expect(roundTrip("| a | n |\n|---|--:|\n| x | 1 |")).toBe(
      ["| a   |   n |", "| --- | --: |", "| x   |   1 |"].join("\n"),
    )
  })

  it("keeps headings, rules and prose in order", () => {
    expect(roundTrip("## Title\n\nbody\n\n---\n\nafter")).toBe(
      "## Title\n\nbody\n\n---\n\nafter",
    )
  })

  it("writes checkboxes back as checkboxes", () => {
    expect(roundTrip("- [x] done\n- [ ] todo")).toBe("- [x] done\n- [ ] todo")
  })

  it("re-indents a nested list and renumbers an ordered one", () => {
    expect(roundTrip("1. one\n   1. inner\n2. two")).toBe(
      "1. one\n  1. inner\n2. two",
    )
  })

  it("re-marks every line of a blockquote", () => {
    expect(roundTrip("> careful\n> here")).toBe("> careful\n> here")
  })

  it("fences code with its language", () => {
    expect(roundTrip("```ts\nconst x = 1\n```")).toBe("```ts\nconst x = 1\n```")
  })

  it("widens the fence when the body already contains one", () => {
    const src = "````md\n```\ninner\n```\n````"
    expect(roundTrip(src)).toBe("````md\n```\ninner\n```\n````")
  })

  it("keeps a diagram as its source", () => {
    expect(roundTrip("```mermaid\nflowchart LR\n  A --> B\n```")).toBe(
      "```mermaid\nflowchart LR\n  A --> B\n```",
    )
  })
})

describe("copying a turn that ran tools", () => {
  it("keeps one audit line per call and drops the private reasoning", () => {
    const src = [
      "Looking into it.",
      "",
      "```thinking",
      "the model talking to itself",
      "```",
      "",
      "```tool:Bash",
      "$ pnpm test",
      "```",
      "",
      "```tool-result:Bash",
      "33 passed",
      "```",
      "",
      "All green.",
    ].join("\n")
    expect(messageToPlainText(src).trimEnd()).toBe(
      "Looking into it.\n\n· $ pnpm test\n\nAll green.",
    )
  })
})

describe("styleBlock", () => {
  it("keeps a block comment open across the newline", () => {
    const lines = styleBlock("/* one\n   two */\nconst x = 1", "js")
    expect(lines[0]!.every((piece) => piece.cls === "comment")).toBe(true)
    expect(lines[1]!.every((piece) => piece.cls === "comment")).toBe(true)
    expect(lines[2]!.some((piece) => piece.cls === "keyword")).toBe(true)
  })

  it("returns one row of pieces per line, losing no characters", () => {
    const code = "const a = 'x'\nreturn a"
    const lines = styleBlock(code, "js")
    expect(lines.map((row) => row.map((p) => p.text).join(""))).toEqual(
      code.split("\n"),
    )
  })
})
