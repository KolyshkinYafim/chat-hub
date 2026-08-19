import { afterEach, describe, expect, it } from "vitest"
import {
  addComment,
  buildReviewMessage,
  clearComments,
  listComments,
  pruneDiffComments,
  removeComment,
  updateComment,
  type DiffCommentInput,
} from "../src/renderer/src/lib/diff-comments"
import {
  onPendingComposerInsert,
  stashComposerInsert,
  takeComposerInsert,
} from "../src/renderer/src/lib/pending-prompt"

const SESSION = "session-a"
const OTHER = "session-b"

function input(overrides: Partial<DiffCommentInput> = {}): DiffCommentInput {
  return {
    file: "src/lib/jwt.ts",
    line: 14,
    lineText: "if (claims.iat < Date.now() / 1000) return null",
    kind: "del",
    text: "The claim being checked is wrong here.",
    ...overrides,
  }
}

afterEach(() => {
  pruneDiffComments(new Set())
  takeComposerInsert(SESSION)
  takeComposerInsert(OTHER)
})

describe("comment store", () => {
  it("adds a comment and lists it for its session only", () => {
    const added = addComment(SESSION, input())
    expect(listComments(SESSION)).toEqual([added])
    expect(listComments(OTHER)).toEqual([])
  })

  it("keeps insertion order and distinct ids", () => {
    const first = addComment(SESSION, input())
    const second = addComment(SESSION, input({ line: 20, text: "Second." }))
    expect(first.id).not.toBe(second.id)
    expect(listComments(SESSION).map((c) => c.id)).toEqual([
      first.id,
      second.id,
    ])
  })

  it("edits a comment's text in place", () => {
    const added = addComment(SESSION, input())
    updateComment(SESSION, added.id, "Sharper wording.")
    expect(listComments(SESSION)).toEqual([
      { ...added, text: "Sharper wording." },
    ])
  })

  it("ignores an edit for an unknown id", () => {
    const added = addComment(SESSION, input())
    updateComment(SESSION, "dc-nope", "Ghost.")
    updateComment(OTHER, added.id, "Wrong session.")
    expect(listComments(SESSION)).toEqual([added])
  })

  it("removes a single comment", () => {
    const first = addComment(SESSION, input())
    const second = addComment(SESSION, input({ line: 20 }))
    removeComment(SESSION, first.id)
    expect(listComments(SESSION)).toEqual([second])
  })

  it("clears the whole session batch", () => {
    addComment(SESSION, input())
    addComment(SESSION, input({ line: 20 }))
    const kept = addComment(OTHER, input())
    clearComments(SESSION)
    expect(listComments(SESSION)).toEqual([])
    expect(listComments(OTHER)).toEqual([kept])
  })

  it("prunes sessions that are no longer live", () => {
    addComment(SESSION, input())
    const kept = addComment(OTHER, input())
    pruneDiffComments(new Set([OTHER]))
    expect(listComments(SESSION)).toEqual([])
    expect(listComments(OTHER)).toEqual([kept])
  })

  it("returns copies that do not alias the store", () => {
    addComment(SESSION, input())
    listComments(SESSION).pop()
    expect(listComments(SESSION)).toHaveLength(1)
  })
})

describe("buildReviewMessage", () => {
  it("returns null for an empty batch", () => {
    expect(buildReviewMessage([])).toBeNull()
  })

  it("formats one entry per comment with the quoted marker line", () => {
    const del = addComment(SESSION, input())
    const add = addComment(SESSION, {
      file: "src/middleware/auth.ts",
      line: 22,
      lineText: "if (!decoded || isPast(decoded.exp)) return res.status(401).end()",
      kind: "add",
      text: "Extract this guard into the shared helper.",
    })
    expect(buildReviewMessage([del, add])).toBe(
      [
        "Review comments on the current diff:",
        "",
        "src/lib/jwt.ts:14",
        "> - if (claims.iat < Date.now() / 1000) return null",
        "The claim being checked is wrong here.",
        "",
        "src/middleware/auth.ts:22",
        "> + if (!decoded || isPast(decoded.exp)) return res.status(401).end()",
        "Extract this guard into the shared helper.",
      ].join("\n"),
    )
  })

  it("quotes a context line with a space marker", () => {
    const ctx = addComment(SESSION, {
      file: "src/app.ts",
      line: 3,
      lineText: "const app = express()",
      kind: "ctx",
      text: "Rename this.",
    })
    expect(buildReviewMessage([ctx])).toBe(
      [
        "Review comments on the current diff:",
        "",
        "src/app.ts:3",
        ">   const app = express()",
        "Rename this.",
      ].join("\n"),
    )
  })

  it("orders entries by file then line regardless of entry order", () => {
    const late = addComment(SESSION, input({ file: "z.ts", line: 2, text: "Z2." }))
    const early = addComment(SESSION, input({ file: "a.ts", line: 9, text: "A9." }))
    const mid = addComment(SESSION, input({ file: "z.ts", line: 1, text: "Z1." }))
    const message = buildReviewMessage([late, early, mid])
    expect(message).not.toBeNull()
    const order = ["a.ts:9", "z.ts:1", "z.ts:2"].map((tag) =>
      (message as string).indexOf(tag),
    )
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
  })

  it("keeps same-file same-line comments in insertion order", () => {
    const first = addComment(SESSION, input({ text: "First thought." }))
    const second = addComment(SESSION, input({ text: "Second thought." }))
    const message = buildReviewMessage([first, second]) as string
    expect(message.indexOf("First thought.")).toBeLessThan(
      message.indexOf("Second thought."),
    )
  })
})

describe("pending composer insert", () => {
  it("stashes per session and hands over exactly once", () => {
    stashComposerInsert(SESSION, "review batch")
    expect(takeComposerInsert(OTHER)).toBeNull()
    expect(takeComposerInsert(SESSION)).toBe("review batch")
    expect(takeComposerInsert(SESSION)).toBeNull()
  })

  it("joins a second stash with a blank line until taken", () => {
    stashComposerInsert(SESSION, "first")
    stashComposerInsert(SESSION, "second")
    expect(takeComposerInsert(SESSION)).toBe("first\n\nsecond")
  })

  it("notifies listeners with the session id and supports unsubscribe", () => {
    const seen: string[] = []
    const off = onPendingComposerInsert((sessionId) => seen.push(sessionId))
    stashComposerInsert(SESSION, "one")
    off()
    stashComposerInsert(SESSION, "two")
    expect(seen).toEqual([SESSION])
  })
})
