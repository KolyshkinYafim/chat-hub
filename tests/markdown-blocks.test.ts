import { describe, expect, it } from "vitest"
import { orderedMarkers, splitBlocks, type Block } from "@renderer/lib/markdown"

function kinds(src: string): string[] {
  return splitBlocks(src).map((block) => block.kind)
}

function only<K extends Block["kind"]>(
  src: string,
  kind: K,
): Extract<Block, { kind: K }> {
  const found = splitBlocks(src).find((block) => block.kind === kind)
  if (!found) throw new Error(`no ${kind} block in ${JSON.stringify(src)}`)
  return found as Extract<Block, { kind: K }>
}

describe("tables", () => {
  it("keeps a table out of the paragraph it used to collapse into", () => {
    const src = [
      "## Where things stand",
      "",
      "| Phase | Status |",
      "|---|---|",
      "| **A** groundwork | done |",
      "| **B** onboarding | **no UI** |",
      "",
      "Next up is B.",
    ].join("\n")
    expect(kinds(src)).toEqual(["h", "table", "p"])
    expect(only(src, "table").table.rows).toHaveLength(2)
  })

  it("reads a table that opens the message with no blank line above it", () => {
    expect(kinds("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual(["table"])
  })

  it("ends the paragraph above a table instead of swallowing it", () => {
    const blocks = splitBlocks("Numbers:\n| a |\n|---|\n| 1 |")
    expect(blocks.map((b) => b.kind)).toEqual(["p", "table"])
  })
})

describe("headings", () => {
  it("reads every level, not just h2 and h3", () => {
    const src = "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six"
    expect(splitBlocks(src).map((b) => (b.kind === "h" ? b.level : 0))).toEqual([
      1, 2, 3, 4, 5, 6,
    ])
  })

  it("strips the closing hashes of an atx heading", () => {
    expect(only("## Title ##", "h").text).toBe("Title")
  })

  it("reads an underlined title", () => {
    expect(only("Release notes\n=============", "h")).toEqual({
      kind: "h",
      level: 2,
      text: "Release notes",
    })
  })

  it("leaves a bare hash without text as prose", () => {
    expect(kinds("#hashtag")).toEqual(["p"])
  })
})

describe("thematic breaks", () => {
  it("renders --- between sections as a rule, not literal text", () => {
    expect(kinds("before\n\n---\n\nafter")).toEqual(["p", "hr", "p"])
  })

  it("accepts the other rule spellings", () => {
    expect(kinds("***")).toEqual(["hr"])
    expect(kinds("___")).toEqual(["hr"])
    expect(kinds("- - -")).toEqual(["hr"])
  })

  it("does not mistake a two-dash line for a rule", () => {
    expect(kinds("--")).toEqual(["p"])
  })
})

describe("lists", () => {
  it("keeps the nesting instead of flattening every item to one level", () => {
    const list = only("- top\n  - nested\n    - deeper", "ul")
    expect(list.items.map((item) => item.depth)).toEqual([0, 1, 2])
    expect(list.items.map((item) => item.text)).toEqual(["top", "nested", "deeper"])
  })

  it("reads checkboxes instead of leaving [ ] in the text", () => {
    const list = only("- [ ] todo\n- [x] done", "ul")
    expect(list.items).toEqual([
      { text: "todo", depth: 0, checked: false },
      { text: "done", depth: 0, checked: true },
    ])
  })

  it("reads a numbered list as a list, not a run-on paragraph", () => {
    const list = only("1. First\n2. Second\n3. Third", "ol")
    expect(list.start).toBe(1)
    expect(list.items.map((item) => item.text)).toEqual([
      "First",
      "Second",
      "Third",
    ])
  })

  it("keeps the number a numbered list actually starts at", () => {
    expect(only("4) Fourth\n5) Fifth", "ol").start).toBe(4)
  })

  it("folds a wrapped continuation line into the item above it", () => {
    const list = only("- first line\n  still the first item\n- second", "ul")
    expect(list.items[0]!.text).toBe("first line still the first item")
    expect(list.items).toHaveLength(2)
  })

  it("still reads the checkmark bullets the adapters emit", () => {
    expect(only("✅ shipped\n✅ verified", "ul").items).toHaveLength(2)
  })
})

describe("orderedMarkers", () => {
  it("restarts a nested run and resumes the level above it", () => {
    const items = [0, 1, 1, 0, 1].map((depth) => ({
      text: "x",
      depth,
      checked: null,
    }))
    expect(orderedMarkers(items, 1)).toEqual([1, 1, 2, 2, 1])
  })

  it("honours the start of the outer list", () => {
    const items = [{ text: "x", depth: 0, checked: null }]
    expect(orderedMarkers(items, 7)).toEqual([7])
  })
})

describe("blockquotes", () => {
  it("parses the quoted body as markdown of its own", () => {
    const quote = only("> ### Warning\n> - one\n> - two", "quote")
    expect(quote.blocks.map((b) => b.kind)).toEqual(["h", "ul"])
  })

  it("nests a quote inside a quote", () => {
    const outer = only("> outer\n> > inner", "quote")
    expect(outer.blocks.map((b) => b.kind)).toEqual(["p", "quote"])
  })

  it("ends the quote at the blank line", () => {
    expect(kinds("> quoted\n\nplain")).toEqual(["quote", "p"])
  })
})

describe("definition lists and footnotes", () => {
  it("reads a term with its definitions", () => {
    const dl = only("Token\n: A signed claim set.\n: Sent on every request.", "dl")
    expect(dl.items).toEqual([
      { term: "Token", details: ["A signed claim set.", "Sent on every request."] },
    ])
  })

  it("collects footnote definitions into one block", () => {
    const notes = only("[^1]: first note\n[^2]: second note", "footnotes")
    expect(notes.items).toEqual([
      { label: "1", text: "first note" },
      { label: "2", text: "second note" },
    ])
  })

  it("folds an indented continuation into the note above it", () => {
    const notes = only("[^a]: the note\n  wraps here", "footnotes")
    expect(notes.items[0]!.text).toBe("the note wraps here")
  })
})

describe("fences still win", () => {
  it("leaves a table inside a code fence untouched", () => {
    const src = "```md\n| a |\n|---|\n| 1 |\n```"
    const code = only(src, "code")
    expect(code.code).toBe("| a |\n|---|\n| 1 |")
  })

  it("leaves a heading-looking comment inside a fence alone", () => {
    expect(kinds("```sh\n# a comment\necho hi\n```")).toEqual(["code"])
  })
})
