import { describe, expect, it } from "vitest"
import type { ChatMessage } from "../src/shared/types"
import {
  markTurnCutByRestart,
  RESTART_CUT_TITLE,
} from "../src/main/session-manager"

const user = (id: string): ChatMessage => ({
  id,
  sessionId: "s",
  role: "user",
  content: "do it",
  createdAt: 1,
})

const assistant = (id: string, items: ChatMessage["items"]): ChatMessage => ({
  id,
  sessionId: "s",
  role: "assistant",
  content: "",
  createdAt: 2,
  items,
})

describe("markTurnCutByRestart", () => {
  it("closes open steps as interrupted and appends the notice", () => {
    const messages = [
      user("u1"),
      assistant("a1", [
        { id: "t1", kind: "tool", status: "completed", name: "Read" },
        { id: "t2", kind: "tool", status: "running", name: "Bash" },
      ] as ChatMessage["items"]),
    ]
    markTurnCutByRestart(messages)
    const items = messages[1]!.items!
    expect(items.map((i) => i.status)).toEqual(["completed", "interrupted", "interrupted"])
    const notice = items[2]!
    expect(notice.kind).toBe("notice")
    if (notice.kind === "notice") expect(notice.title).toBe(RESTART_CUT_TITLE)
  })

  it("adds an assistant turn when the process died before the model answered", () => {
    const messages = [user("u1")]
    markTurnCutByRestart(messages)
    expect(messages).toHaveLength(2)
    expect(messages[1]!.role).toBe("assistant")
    expect(messages[1]!.items?.[0]?.kind).toBe("notice")
  })

  it("does not stack a second notice on a turn already marked", () => {
    const messages = [user("u1"), assistant("a1", [])]
    markTurnCutByRestart(messages)
    markTurnCutByRestart(messages)
    expect(messages[1]!.items).toHaveLength(1)
  })

  it("leaves an empty transcript alone", () => {
    const messages: ChatMessage[] = []
    markTurnCutByRestart(messages)
    expect(messages).toEqual([])
  })
})
