import { describe, expect, it } from "vitest"
import { renderCliFailure } from "../src/main/adapters/failure-message"
import { extractGrokAction, extractGrokText } from "../src/main/adapters/grok"
import {
  formatInteractiveAnswer,
  InteractiveQuestionStream,
  parseInteractiveQuestion,
} from "../src/main/adapters/interactive-input"

describe("Grok Build 0.2.x stream compatibility", () => {
  it("renders the current text/data event instead of completing silently", () => {
    expect(extractGrokText({ type: "text", data: "OK" })).toBe("OK")
  })

  it("does not leak reasoning events into the transcript", () => {
    expect(extractGrokText({ type: "thought", data: "internal" })).toBe("")
  })

  it("normalizes a tool lifecycle event into structured activity", () => {
    expect(extractGrokAction({
      type: "tool_call",
      id: "call-1",
      name: "Read",
      input: { path: "src/a.ts" },
    })).toMatchObject({
      id: "grok-call-1",
      kind: "tool",
      status: "running",
      name: "Read",
    })
  })
})

describe("CLI failure copy", () => {
  it("offers login only when OpenCode's diagnostic indicates auth/configuration", () => {
    const rendered = renderCliFailure("OpenCode", 1, ["No credentials configured"])
    expect(rendered).toContain("opencode auth login")
    expect(rendered).not.toContain("auto-approve")
  })

  it("keeps Grok's diagnostic without an irrelevant OpenCode login hint", () => {
    const rendered = renderCliFailure("Grok", 1, ["Not signed in"])
    expect(rendered).toContain("Not signed in")
    expect(rendered).not.toContain("opencode auth login")
  })
})

describe("universal interactive questions", () => {
  const marker = '<chat-hub-question>{"header":"Deploy","prompt":"Where should I deploy?","options":[{"label":"Staging"}]}</chat-hub-question>'

  it("withholds a split marker from the transcript and produces a form", () => {
    const stream = new InteractiveQuestionStream()
    expect(stream.push("Checked the diff.\n\n<chat-hub-que")).toBe("Checked the diff.\n\n")
    expect(stream.push("stion>{\"header\":\"Deploy\",\"prompt\":\"Where should I deploy?\"}</chat-hub-question>")).toBe("")
    expect(stream.finish()).toEqual({
      visible: "",
      question: {
        // allowOther: the answer goes back as prose, so any wording works.
        questions: [{ id: "answer", header: "Deploy", prompt: "Where should I deploy?", options: undefined, allowOther: true }],
      },
    })
  })

  it("keeps malformed markers visible instead of silently swallowing text", () => {
    const stream = new InteractiveQuestionStream()
    stream.push("<chat-hub-question>{bad}</chat-hub-question>")
    expect(stream.finish()).toEqual({
      visible: "<chat-hub-question>{bad}</chat-hub-question>",
      question: null,
    })
  })

  it("turns a form answer into an explicit continuation prompt", () => {
    const question = parseInteractiveQuestion(marker)
    expect(question).not.toBeNull()
    expect(formatInteractiveAnswer(question!, { answer: ["Staging"] })).toContain("Staging")
  })
})
