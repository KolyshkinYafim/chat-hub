import { describe, expect, it } from "vitest"
import {
  classifyInlineCode,
  inlineToPlainText,
  isFilePath,
  parseInline,
  type InlineToken,
} from "@renderer/lib/markdown-inline"

function kinds(text: string): string[] {
  return parseInline(text).map((token) => token.kind)
}

function first<K extends InlineToken["kind"]>(
  text: string,
  kind: K,
): Extract<InlineToken, { kind: K }> {
  const found = parseInline(text).find((token) => token.kind === kind)
  if (!found) throw new Error(`no ${kind} token in ${JSON.stringify(text)}`)
  return found as Extract<InlineToken, { kind: K }>
}

describe("emphasis", () => {
  it("reads bold, italic and strikethrough", () => {
    expect(kinds("**b** and *i* and ~~s~~")).toEqual([
      "strong",
      "text",
      "em",
      "text",
      "strike",
    ])
  })

  it("reads bold-italic as one nested pair", () => {
    const token = first("***loud***", "strong")
    expect(token.children).toEqual([
      { kind: "em", children: [{ kind: "text", text: "loud" }] },
    ])
  })

  it("keeps a code span inside bold", () => {
    const token = first("**run `pnpm test` now**", "strong")
    expect(token.children.map((child) => child.kind)).toEqual([
      "text",
      "code",
      "text",
    ])
  })

  it("leaves snake_case identifiers alone", () => {
    expect(kinds("use max_retry_count here")).toEqual(["text"])
  })

  it("leaves a lone asterisk alone", () => {
    expect(kinds("2 * 3 = 6")).toEqual(["text"])
  })

  it("honours a backslash escape", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([
      { kind: "text", text: "*not italic*" },
    ])
  })
})

describe("links and images", () => {
  it("reads a labelled link", () => {
    const link = first("see [the notes](https://example.com/a) please", "link")
    expect(link.url).toBe("https://example.com/a")
    expect(link.children).toEqual([{ kind: "text", text: "the notes" }])
  })

  it("reads a bare url without its trailing period", () => {
    expect(first("go to https://example.com/a. now", "autolink").url).toBe(
      "https://example.com/a",
    )
  })

  it("reads an image reference", () => {
    const image = first("![a chart](https://example.com/c.png)", "image")
    expect(image).toEqual({
      kind: "image",
      url: "https://example.com/c.png",
      alt: "a chart",
    })
  })

  it("reads a footnote reference", () => {
    expect(first("claim[^1]", "footnote").label).toBe("1")
  })

  it("leaves an unclosed bracket as text", () => {
    expect(kinds("an [unclosed label")).toEqual(["text"])
  })
})

describe("classifyInlineCode", () => {
  it("calls a keyboard chord a chord", () => {
    for (const chord of ["Cmd+K", "Ctrl+Shift+P", "Alt+F4", "⌘K", "Esc", "Enter"]) {
      expect(classifyInlineCode(chord)).toBe("kbd")
    }
  })

  it("calls a path a path", () => {
    for (const path of [
      "src/lib/jwt.ts",
      "./scripts/build.sh",
      "/Users/dev/code/orbit-api",
      "~/.config/app.json",
    ]) {
      expect(classifyInlineCode(path)).toBe("path")
    }
  })

  it("leaves ordinary code alone", () => {
    for (const code of [
      "verifyJwt()",
      "a + b",
      "x-1",
      "https://example.com/a",
      "SELECT 1",
    ]) {
      expect(classifyInlineCode(code)).toBe("code")
    }
  })
})

describe("isFilePath", () => {
  it("rejects a url and anything with a space", () => {
    expect(isFilePath("https://example.com/a")).toBe(false)
    expect(isFilePath("src/a b.ts")).toBe(false)
  })

  it("rejects a bare slash between two words", () => {
    expect(isFilePath("either/or")).toBe(false)
  })
})

describe("inlineToPlainText", () => {
  it("gives back what a human would read", () => {
    expect(
      inlineToPlainText(parseInline("**bold** `code` [label](https://a.example/x)")),
    ).toBe("bold code label (https://a.example/x)")
  })
})
