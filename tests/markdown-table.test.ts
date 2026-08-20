import { describe, expect, it } from "vitest"
import {
  columnAlign,
  isNumericCell,
  readTable,
  splitRow,
  tableToMarkdown,
  tableToTsv,
  type MarkdownTable,
} from "@renderer/lib/markdown-table"

function read(src: string): MarkdownTable {
  const found = readTable(src.trim().split("\n"), 0)
  if (!found) throw new Error("no table parsed")
  return found.table
}

describe("splitRow", () => {
  it("drops the outer pipes and trims each cell", () => {
    expect(splitRow("| a | b | c |")).toEqual(["a", "b", "c"])
  })

  it("reads a row written without outer pipes", () => {
    expect(splitRow("a | b")).toEqual(["a", "b"])
  })

  it("keeps an escaped pipe inside the cell it belongs to", () => {
    expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"])
  })
})

describe("readTable", () => {
  it("reads the compact separator form agents actually write", () => {
    const table = read(
      [
        "| Phase | Status |",
        "|---|---|",
        "| **A** groundwork | done |",
        "| **B** onboarding | not started |",
      ].join("\n"),
    )
    expect(table.head).toEqual(["Phase", "Status"])
    expect(table.rows).toEqual([
      ["**A** groundwork", "done"],
      ["**B** onboarding", "not started"],
    ])
  })

  it("keeps inline markdown inside a cell for the renderer to handle", () => {
    const table = read("| Where |\n|---|\n| `src/lib/jwt.ts` |")
    expect(table.rows[0]).toEqual(["`src/lib/jwt.ts`"])
  })

  it("reads the alignment markers and leaves a bare row automatic", () => {
    const table = read("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |")
    expect(table.align).toEqual(["left", "center", "right", "auto"])
  })

  it("refuses a pipe line with no delimiter row under it", () => {
    expect(readTable(["| a | b |", "| 1 | 2 |"], 0)).toBeNull()
  })

  it("leaves a shell pipeline above a thematic break as prose", () => {
    expect(readTable(["run ps aux | grep node", "---"], 0)).toBeNull()
  })

  it("refuses a delimiter row whose width does not match the header", () => {
    expect(readTable(["| a | b |", "|---|---|---|"], 0)).toBeNull()
  })

  it("pads a short row and truncates a long one to the header width", () => {
    const table = read("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")
    expect(table.rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ])
  })

  it("stops at the first line that is not a row", () => {
    const found = readTable(["| a |", "|---|", "| 1 |", "", "after"], 0)
    expect(found?.next).toBe(3)
  })
})

describe("columnAlign", () => {
  it("right-aligns a column of numbers the author did not mark", () => {
    const table = read("| name | count |\n|---|---|\n| a | 1 |\n| b | 1,204 |")
    expect(columnAlign(table, 0)).toBe("left")
    expect(columnAlign(table, 1)).toBe("right")
  })

  it("leaves a mixed column alone", () => {
    const table = read("| a |\n|---|\n| 1 |\n| later |")
    expect(columnAlign(table, 0)).toBe("left")
  })

  it("ignores blank and dash placeholders when judging a column", () => {
    const table = read("| a |\n|---|\n| 12 |\n| — |\n|  |")
    expect(columnAlign(table, 0)).toBe("right")
  })

  it("never overrides an explicit marker", () => {
    expect(columnAlign(read("| a |\n|:-:|\n| 1 |\n| 2 |"), 0)).toBe("center")
    expect(columnAlign(read("| a |\n|:--|\n| 1 |\n| 2 |"), 0)).toBe("left")
  })
})

describe("isNumericCell", () => {
  it("accepts the shapes a report uses", () => {
    for (const cell of ["1", "-2", "1,204", "3.5", "91%", "$12.00", "21ms", "1.62s"]) {
      expect(isNumericCell(cell)).toBe(true)
    }
  })

  it("rejects prose", () => {
    for (const cell of ["done", "v2", "2 passed", ""]) {
      expect(isNumericCell(cell)).toBe(false)
    }
  })
})

describe("tableToMarkdown", () => {
  it("pads the columns and keeps the alignment markers", () => {
    const table = read("| name | n |\n|:--|--:|\n| alpha | 1 |\n| b | 22 |")
    expect(tableToMarkdown(table)).toBe(
      [
        "| name  |   n |",
        "| :---- | --: |",
        "| alpha |   1 |",
        "| b     |  22 |",
      ].join("\n"),
    )
  })

  it("re-escapes a pipe that lived inside a cell", () => {
    const table = read("| a |\n|---|\n| x \\| y |")
    expect(tableToMarkdown(table)).toContain("x \\| y")
  })
})

describe("tableToTsv", () => {
  it("puts a tab between cells and a newline between rows", () => {
    const table = read("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |")
    expect(tableToTsv(table)).toBe("a\tb\n1\t2\n3\t4")
  })

  it("flattens whitespace inside a cell so the columns survive the paste", () => {
    const table: MarkdownTable = {
      head: ["a"],
      align: ["left"],
      rows: [["one\ttwo"]],
    }
    expect(tableToTsv(table)).toBe("a\none two")
  })
})
