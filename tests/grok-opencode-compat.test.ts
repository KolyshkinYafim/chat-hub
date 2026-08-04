import { describe, expect, it } from "vitest"
import { renderCliFailure } from "../src/main/adapters/failure-message"
import { extractGrokAction, extractGrokText } from "../src/main/adapters/grok"

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
