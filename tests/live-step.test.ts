import { describe, expect, it } from "vitest"
import { toolResultBlock, toolUseBlock } from "../src/main/adapters/stream-parse"
import { buildTranscript } from "@renderer/lib/tool-runs"
import {
  currentStep,
  formatElapsed,
  itemPlanProgress,
  itemStep,
  planProgress,
} from "@renderer/lib/live-step"
import { summarizeToolArgs } from "@shared/tool-card"
import type { AgentTurnItem } from "@shared/types"

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

/**
 * Item payloads as the real CLIs send them: Grok's `read_file` with
 * `rawInput`, and Codex's zsh-wrapped command. Both used to reach the ticker as
 * nothing at all, because the live step was read from the prose only.
 */
describe("itemStep", () => {
  const readFile: AgentTurnItem = {
    id: "grok-call-0",
    kind: "tool",
    status: "running",
    name: "read_file",
    arguments: { target_file: "notes.txt" },
  }
  const shell: AgentTurnItem = {
    id: "exec-1",
    kind: "command",
    status: "running",
    command: "/bin/zsh -lc \"sed -n '2p' notes.txt && echo hi\"",
    cwd: "/p",
  }

  it("returns nothing when the turn has no items", () => {
    expect(itemStep(undefined)).toBeNull()
    expect(itemStep([])).toBeNull()
  })

  it("names the running tool and what it is working on", () => {
    expect(itemStep([readFile])).toMatchObject({
      kind: "tool",
      label: "read_file",
      detail: "notes.txt",
      server: null,
    })
  })

  it("shows the command a shell card is running, without the zsh wrapper", () => {
    expect(itemStep([shell])).toMatchObject({
      label: "Shell",
      detail: "sed -n '2p' notes.txt && echo hi",
    })
  })

  it("prefers the newest open action over reasoning still streaming", () => {
    const reasoning: AgentTurnItem = {
      id: "r",
      kind: "reasoning",
      status: "running",
      summary: "weighing the output",
    }
    expect(itemStep([reasoning, shell])).toMatchObject({ label: "Shell" })
  })

  it("names the running call, not one queued behind it", () => {
    expect(
      itemStep([
        { ...readFile, status: "completed" },
        shell,
        { id: "exec-2", kind: "command", status: "pending", command: "pnpm lint" },
      ]),
    ).toMatchObject({ label: "Shell", detail: "sed -n '2p' notes.txt && echo hi" })
  })

  it("names the first queued call once nothing is running", () => {
    expect(
      itemStep([
        { id: "exec-2", kind: "command", status: "pending", command: "pnpm lint" },
        { id: "exec-3", kind: "command", status: "pending", command: "pnpm build" },
      ]),
    ).toMatchObject({ label: "Shell", detail: "pnpm lint" })
  })

  it("falls back to thinking while only reasoning is open", () => {
    expect(
      itemStep([
        { ...readFile, status: "completed" },
        { id: "r", kind: "reasoning", status: "running", summary: "next" },
      ]),
    ).toMatchObject({ kind: "thinking", label: "Thinking" })
  })

  it("goes quiet once every item has settled", () => {
    expect(itemStep([{ ...readFile, status: "completed" }])).toBeNull()
  })

  it("splits an MCP tool into its short name and server", () => {
    expect(
      itemStep([{ ...readFile, name: "mcp__slack__users_search" }]),
    ).toMatchObject({ label: "users_search", server: "slack" })
  })

  it("changes its key with the item so the clock restarts", () => {
    expect(itemStep([readFile])?.key).not.toBe(itemStep([shell])?.key)
  })
})

describe("itemPlanProgress", () => {
  it("counts a provider's own checklist item", () => {
    expect(
      itemPlanProgress([
        {
          id: "grok-plan",
          kind: "plan",
          status: "running",
          text: "Report what happened",
          steps: [
            { text: "Run the command", status: "completed" },
            { text: "Report what happened", status: "running" },
          ],
        },
      ]),
    ).toEqual({ done: 1, total: 2, active: "Report what happened" })
  })

  it("returns null when no item carries steps", () => {
    expect(itemPlanProgress([])).toBeNull()
  })
})

describe("summarizeToolArgs", () => {
  it("prefers the command over the description grok sends beside it", () => {
    expect(
      summarizeToolArgs({ command: "echo hi", description: "Print hi" }),
    ).toBe("echo hi")
  })

  it("reads whichever spelling of a path the CLI used", () => {
    expect(summarizeToolArgs({ target_file: "notes.txt" })).toBe("notes.txt")
    expect(summarizeToolArgs({ file_path: "src/a.ts" })).toBe("src/a.ts")
  })

  it("summarizes a checklist by its active step", () => {
    expect(
      summarizeToolArgs({
        todos: [
          { content: "done thing", status: "completed" },
          { content: "current thing", status: "in_progress" },
        ],
      }),
    ).toBe("current thing")
  })

  it("falls back to compact JSON rather than saying nothing", () => {
    expect(summarizeToolArgs({ depth: 2, recurse: true })).toBe(
      '{"depth":2,"recurse":true}',
    )
  })

  it("stays empty for an argument-free call", () => {
    expect(summarizeToolArgs({})).toBe("")
    expect(summarizeToolArgs(undefined)).toBe("")
  })
})
