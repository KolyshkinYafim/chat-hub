import { describe, expect, it } from "vitest"
import type { ChatMessage } from "../src/shared/types"
import {
  editSignalInMessage,
  editedPathsInMessage,
} from "../src/renderer/src/lib/agent-actions"

function message(items: ChatMessage["items"]): ChatMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content: "",
    createdAt: 1,
    streaming: true,
    items,
  }
}

describe("editSignalInMessage", () => {
  it("finds paths in a live aggregate Codex diff", () => {
    const signal = editSignalInMessage(
      message([
        {
          id: "turn-diff",
          kind: "file_change",
          status: "running",
          changes: [],
          aggregateDiff: [
            "diff --git a/src/old.ts b/src/new.ts",
            "--- a/src/old.ts",
            "+++ b/src/new.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
          ].join("\n"),
        },
      ]),
    )

    expect(signal?.paths).toEqual(["src/new.ts"])
  })

  it("changes revision when the same file edit settles", () => {
    const running = editSignalInMessage(
      message([
        {
          id: "edit-1",
          kind: "file_change",
          status: "running",
          changes: [{ path: "src/app.ts" }],
        },
      ]),
    )
    const completed = editSignalInMessage(
      message([
        {
          id: "edit-1",
          kind: "file_change",
          status: "completed",
          changes: [{ path: "src/app.ts", diff: "@@ -1 +1 @@\n- a\n+ b" }],
        },
      ]),
    )

    expect(running?.paths).toEqual(["src/app.ts"])
    expect(completed?.paths).toEqual(["src/app.ts"])
    expect(completed?.revision).not.toBe(running?.revision)
  })

  it("keeps the legacy path helper aligned with the richer signal", () => {
    const value = message([
      {
        id: "edit-1",
        kind: "file_change",
        status: "completed",
        changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      },
    ])

    expect(editedPathsInMessage(value)).toEqual(["src/a.ts", "src/b.ts"])
  })
})
