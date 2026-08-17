import { describe, expect, it } from "vitest"
import type { GitFileChange } from "../src/shared/types"
import { leftBehindWarning } from "../src/renderer/src/lib/publish-gate"

function file(path: string, index: string, work: string): GitFileChange {
  return { path, index, work }
}

describe("leftBehindWarning", () => {
  it("stays silent when everything is staged and tracked", () => {
    expect(
      leftBehindWarning(
        { "a.ts": { staged: 2, unstaged: 0 } },
        [file("a.ts", "M", " ")],
      ),
    ).toBeNull()
    expect(leftBehindWarning({}, [])).toBeNull()
  })

  it("counts unstaged hunks across files", () => {
    expect(
      leftBehindWarning(
        {
          "a.ts": { staged: 1, unstaged: 2 },
          "b.ts": { staged: 0, unstaged: 1 },
          "c.ts": { staged: 3, unstaged: 0 },
        },
        [file("a.ts", "M", "M"), file("b.ts", " ", "M"), file("c.ts", "M", " ")],
      ),
    ).toBe("3 hunks in 2 files are not staged and will not be pushed.")
    expect(
      leftBehindWarning({ "a.ts": { staged: 0, unstaged: 1 } }, []),
    ).toBe("1 hunk in 1 file is not staged and will not be pushed.")
  })

  it("names untracked files, which produce no textual hunks at all", () => {
    expect(
      leftBehindWarning({}, [file("tests/new.test.ts", " ", "?")]),
    ).toBe("1 untracked file is not staged and will not be pushed.")
    expect(
      leftBehindWarning({}, [
        file("tests/new.test.ts", " ", "?"),
        file("notes.md", " ", "?"),
        file("staged.ts", "M", " "),
      ]),
    ).toBe("2 untracked files are not staged and will not be pushed.")
  })

  it("combines hunks and untracked files into one sentence", () => {
    expect(
      leftBehindWarning({ "a.ts": { staged: 0, unstaged: 1 } }, [
        file("a.ts", " ", "M"),
        file("new.ts", " ", "?"),
      ]),
    ).toBe(
      "1 hunk in 1 file and 1 untracked file are not staged and will not be pushed.",
    )
  })

  it("admits unavailable counts instead of implying everything is staged", () => {
    const warning = leftBehindWarning(null, [])
    expect(warning).toMatch(/unavailable/i)
    expect(warning).toMatch(/before publishing/i)
  })
})
