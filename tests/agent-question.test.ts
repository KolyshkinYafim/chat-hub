import { describe, expect, it } from "vitest"
import {
  answerPayload,
  answerValue,
  answersReady,
  askerLabel,
  EMPTY_ANSWER,
  questionContext,
  toQuestionCards,
  type QuestionAnswer,
} from "@renderer/lib/agent-question"
import type {
  AgentInputQuestion,
  AgentInputRequestInfo,
  AgentTurnItem,
  ChatMessage,
} from "@shared/types"

function request(...questions: AgentInputQuestion[]): AgentInputRequestInfo {
  return {
    requestId: "req-1",
    sessionId: "s1",
    source: "codex",
    questions,
    createdAt: 0,
  }
}

function assistant(content: string, items?: AgentTurnItem[]): ChatMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content,
    createdAt: 0,
    items,
  }
}

const answered = (answer: Partial<QuestionAnswer>): QuestionAnswer => ({
  ...EMPTY_ANSWER,
  ...answer,
})

describe("toQuestionCards", () => {
  it("keeps a header that adds a topic the question does not carry", () => {
    const [card] = toQuestionCards(
      request({ id: "a", header: "Lockfile", prompt: "Which one should CI install from?" }),
    )
    expect(card!.topic).toBe("Lockfile")
    expect(card!.prompt).toBe("Which one should CI install from?")
  })

  it("drops a header that only restates the question", () => {
    const [card] = toQuestionCards(
      request({ id: "a", header: "Which lockfile?", prompt: "Which lockfile should CI install from?" }),
    )
    expect(card!.topic).toBeNull()
  })

  it("surfaces option descriptions instead of hiding them in a tooltip", () => {
    const [card] = toQuestionCards(
      request({
        id: "a",
        header: "Lockfile",
        prompt: "Which one?",
        options: [
          { label: "pnpm-lock.yaml", description: "  What the repo already ships  " },
          { label: "package-lock.json" },
        ],
      }),
    )
    expect(card!.options).toEqual([
      { label: "pnpm-lock.yaml", description: "What the repo already ships" },
      { label: "package-lock.json", description: null },
    ])
  })

  it("allows free text when the question carries no options", () => {
    const [card] = toQuestionCards(request({ id: "a", header: "Name", prompt: "What should it be called?" }))
    expect(card!.allowOther).toBe(true)
  })

  it("refuses free text when a CLI offers options and does not accept others", () => {
    const [card] = toQuestionCards(
      request({ id: "a", header: "Proceed", prompt: "Accept?", options: [{ label: "Accept" }, { label: "Decline" }] }),
    )
    expect(card!.allowOther).toBe(false)
  })

  it("honours a CLI that does accept an answer outside its options", () => {
    const [card] = toQuestionCards(
      request({
        id: "a",
        header: "Proceed",
        prompt: "Which branch?",
        options: [{ label: "main" }],
        allowOther: true,
      }),
    )
    expect(card!.allowOther).toBe(true)
  })

  it("falls back to the header when a question arrives with an empty prompt", () => {
    const [card] = toQuestionCards(request({ id: "a", header: "Deploy target", prompt: "  " }))
    expect(card!.prompt).toBe("Deploy target")
    expect(card!.topic).toBeNull()
  })
})

describe("askerLabel", () => {
  it("names the CLI that stopped to ask", () => {
    expect(askerLabel("codex")).toBe("Codex asks")
    expect(askerLabel("claude")).toBe("Claude asks")
  })

  it("names an MCP server rather than the protocol carrying it", () => {
    expect(askerLabel("mcp:docs")).toBe("Docs (MCP) asks")
  })

  it("says something sensible for a source it cannot read", () => {
    expect(askerLabel("")).toBe("Agent asks")
    expect(askerLabel("mcp:")).toBe("Mcp asks")
  })
})

describe("answerValue", () => {
  const [choiceCard] = toQuestionCards(
    request({
      id: "a",
      header: "Lockfile",
      prompt: "Which one?",
      options: [{ label: "pnpm-lock.yaml" }],
      allowOther: true,
    }),
  )
  const [textCard] = toQuestionCards(request({ id: "b", header: "Name", prompt: "What name?" }))

  it("is empty until something is picked or typed", () => {
    expect(answerValue(choiceCard!, undefined)).toBe("")
    expect(answerValue(textCard!, undefined)).toBe("")
  })

  it("sends the picked option, not whatever was typed before", () => {
    expect(
      answerValue(choiceCard!, answered({ choice: "pnpm-lock.yaml", text: "half a thought" })),
    ).toBe("pnpm-lock.yaml")
  })

  it("sends the owner's own words once they take that route", () => {
    expect(
      answerValue(choiceCard!, answered({ choice: "pnpm-lock.yaml", text: "  neither, use npm  ", own: true })),
    ).toBe("neither, use npm")
  })

  it("treats the field as the answer when there is nothing to pick", () => {
    expect(answerValue(textCard!, answered({ text: "orbit-api" }))).toBe("orbit-api")
  })
})

describe("answersReady", () => {
  const cards = toQuestionCards(
    request(
      { id: "a", header: "Lockfile", prompt: "Which one?", options: [{ label: "pnpm-lock.yaml" }] },
      { id: "b", header: "Name", prompt: "What name?" },
    ),
  )

  it("stays false while any question is unanswered", () => {
    expect(answersReady(cards, { a: answered({ choice: "pnpm-lock.yaml" }) })).toBe(false)
  })

  it("is false for a request that carries no question at all", () => {
    expect(answersReady([], {})).toBe(false)
  })

  it("turns true once every question has a value", () => {
    const answers = { a: answered({ choice: "pnpm-lock.yaml" }), b: answered({ text: "orbit" }) }
    expect(answersReady(cards, answers)).toBe(true)
    expect(answerPayload(cards, answers)).toEqual({ a: ["pnpm-lock.yaml"], b: ["orbit"] })
  })

  it("ignores whitespace typed into a free-text answer", () => {
    expect(answersReady(cards, { a: answered({ choice: "x" }), b: answered({ text: "   " }) })).toBe(false)
  })
})

describe("questionContext", () => {
  it("has nothing to say without a turn behind it", () => {
    expect(questionContext(null)).toEqual({ lead: null, steps: [] })
    expect(questionContext({ ...assistant(""), role: "user" })).toEqual({ lead: null, steps: [] })
  })

  it("takes the agent's last prose line, past its fenced blocks", () => {
    const message = assistant(
      "Reading the lockfiles first.\n\n```bash\npnpm install\n```\n\nBoth **lockfiles** are checked in, so `pnpm` and `npm` disagree.",
    )
    expect(questionContext(message).lead).toBe(
      "Both lockfiles are checked in, so pnpm and npm disagree.",
    )
  })

  it("survives a fence the turn stopped inside", () => {
    expect(questionContext(assistant("Looking.\n\n```bash\npnpm install")).lead).toBe("Looking.")
  })

  it("names the last few things the agent actually did", () => {
    const items: AgentTurnItem[] = [
      { id: "1", kind: "reasoning", status: "completed", summary: "Two lockfiles disagree" },
      { id: "2", kind: "tool", status: "completed", name: "Grep", arguments: { pattern: "lock" } },
      { id: "3", kind: "command", status: "completed", command: "ls -1" },
      { id: "4", kind: "file_change", status: "completed", changes: [{ path: "ci.yml" }, { path: "release.yml" }] },
      { id: "5", kind: "command", status: "pending", command: "pnpm install" },
    ]
    expect(questionContext(assistant("Asking.", items)).steps).toEqual([
      "Grep · lock",
      "Shell · ls -1",
      "Edit · 2 files",
    ])
  })

  it("keeps only the last three, and never the same line twice in a row", () => {
    const items: AgentTurnItem[] = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      kind: "command",
      status: "completed",
      command: "pnpm test",
    }))
    expect(questionContext(assistant("", items)).steps).toEqual(["Shell · pnpm test"])
  })
})
