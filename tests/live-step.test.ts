import { describe, expect, it } from "vitest"
import { toolResultBlock, toolUseBlock } from "../src/main/adapters/stream-parse"
import { buildTranscript } from "@renderer/lib/tool-runs"
import {
  currentStep,
  formatElapsed,
  planProgress,
} from "@renderer/lib/live-step"

function stepFor(src: string) {
  return currentStep(buildTranscript(src).blocks)
}

function progressFor(src: string) {
  return planProgress(buildTranscript(src).blocks)
}

const reasoning = (text: string) => `\n\n\`\`\`thinking\n${text}\n\`\`\`\n\n`

describe("currentStep", () => {
  it("reports starting before anything has parsed", () => {
    const step = stepFor("")
    expect(step.kind).toBe("starting")
    expect(step.label).toBe("Starting")
    expect(step.detail).toBeNull()
  })

  it("names a tool call still awaiting its result", () => {
    const step = stepFor(toolUseBlock("Bash", { command: "pnpm test" }, "toolu_a"))
    expect(step.kind).toBe("tool")
    expect(step.label).toBe("Bash")
    expect(step.detail).toBe("pnpm test")
    expect(step.server).toBeNull()
  })

  it("prefers the CLI description over the raw command", () => {
    const step = stepFor(
      toolUseBlock(
        "Bash",
        { command: "pnpm test", description: "Run the unit tests" },
        "toolu_a",
      ),
    )
    expect(step.detail).toBe("Run the unit tests")
  })

  it("lets an open tool call win over reasoning streamed after it", () => {
    const step = stepFor(
      toolUseBlock("Bash", { command: "pnpm test" }, "toolu_a") +
        reasoning("weighing the output so far"),
    )
    expect(step.kind).toBe("tool")
    expect(step.label).toBe("Bash")
  })

  it("flips to writing once the result closes the call and prose streams", () => {
    const step = stepFor(
      toolUseBlock("Bash", { command: "pnpm test" }, "toolu_a") +
        toolResultBlock("Bash", "2 passed", { id: "toolu_a" }) +
        "All tests pass, summarizing.",
    )
    expect(step.kind).toBe("writing")
    expect(step.label).toBe("Writing")
  })

  it("flips to thinking once the result closes the call and reasoning streams", () => {
    const step = stepFor(
      toolUseBlock("Bash", { command: "pnpm test" }, "toolu_a") +
        toolResultBlock("Bash", "2 passed", { id: "toolu_a" }) +
        reasoning("deciding the next command"),
    )
    expect(step.kind).toBe("thinking")
    expect(step.label).toBe("Thinking")
  })

  it("treats a freshly closed call with nothing after it as thinking", () => {
    const step = stepFor(
      toolUseBlock("Bash", { command: "pnpm test" }, "toolu_a") +
        toolResultBlock("Bash", "2 passed", { id: "toolu_a" }),
    )
    expect(step.kind).toBe("thinking")
  })

  it("splits an MCP tool into its short name and server", () => {
    const step = stepFor(
      toolUseBlock(
        "mcp__chathub-browser__browser_click",
        { selector: "#send" },
        "toolu_m",
      ),
    )
    expect(step.label).toBe("browser_click")
    expect(step.server).toBe("chathub-browser")
  })

  it("changes its key when the step changes so the clock restarts", () => {
    const call = toolUseBlock("Bash", { command: "pnpm test" }, "toolu_a")
    const during = stepFor(call)
    const after = stepFor(
      call + toolResultBlock("Bash", "2 passed", { id: "toolu_a" }) + "Done.",
    )
    expect(during.key).not.toBe(after.key)
  })
})

describe("planProgress", () => {
  const plan = (todos: { content: string; status: string }[]) =>
    toolUseBlock("TodoWrite", { todos }, `plan_${Math.random()}`)

  it("returns null when the message carries no plan", () => {
    expect(progressFor("Just prose.")).toBeNull()
    expect(
      progressFor(toolUseBlock("Bash", { command: "ls" }, "toolu_a")),
    ).toBeNull()
  })

  it("counts completed steps and surfaces the in_progress text", () => {
    const progress = progressFor(
      plan([
        { content: "scaffold", status: "completed" },
        { content: "wire ticker", status: "in_progress" },
        { content: "tests", status: "pending" },
      ]),
    )
    expect(progress).toEqual({ done: 1, total: 3, active: "wire ticker" })
  })

  it("uses the last plan occurrence in the message", () => {
    const progress = progressFor(
      plan([
        { content: "scaffold", status: "in_progress" },
        { content: "tests", status: "pending" },
      ]) +
        "Some prose between updates." +
        plan([
          { content: "scaffold", status: "completed" },
          { content: "tests", status: "in_progress" },
        ]),
    )
    expect(progress).toEqual({ done: 1, total: 2, active: "tests" })
  })

  it("leaves active null when no step is in progress", () => {
    const progress = progressFor(
      plan([
        { content: "scaffold", status: "completed" },
        { content: "tests", status: "completed" },
      ]),
    )
    expect(progress).toEqual({ done: 2, total: 2, active: null })
  })
})

describe("formatElapsed", () => {
  it("renders plain seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s")
    expect(formatElapsed(12_000)).toBe("12s")
    expect(formatElapsed(59_999)).toBe("59s")
  })

  it("rolls sixty seconds into minutes with zero-padded seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m 00s")
    expect(formatElapsed(65_000)).toBe("1m 05s")
    expect(formatElapsed(754_000)).toBe("12m 34s")
  })

  it("rolls an hour into hours with zero-padded minutes", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 00m")
    expect(formatElapsed(3_720_000)).toBe("1h 02m")
  })

  it("clamps a negative duration to zero", () => {
    expect(formatElapsed(-5_000)).toBe("0s")
  })
})
