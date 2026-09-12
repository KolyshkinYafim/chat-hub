import { describe, expect, it } from "vitest"
import {
  buildTurnPhases,
  callPhase,
  itemPhase,
  shellPhase,
  testResult,
  toolPhase,
} from "@renderer/lib/turn-phases"
import { buildTranscript } from "@renderer/lib/tool-runs"
import { toolUseBlock } from "../src/main/adapters/stream-parse"
import type { AgentTurnItem } from "@shared/types"

const reasoning = (
  id: string,
  summary: string,
  status: AgentTurnItem["status"] = "completed",
): AgentTurnItem => ({ id, kind: "reasoning", status, summary })

const shell = (
  id: string,
  command: string,
  extra: Partial<Extract<AgentTurnItem, { kind: "command" }>> = {},
): AgentTurnItem => ({
  id,
  kind: "command",
  status: "completed",
  command,
  ...extra,
})

const tool = (
  id: string,
  name: string,
  args?: unknown,
  status: AgentTurnItem["status"] = "completed",
): AgentTurnItem => ({ id, kind: "tool", status, name, arguments: args })

const edit = (id: string, ...paths: string[]): AgentTurnItem => ({
  id,
  kind: "file_change",
  status: "completed",
  changes: paths.map((path) => ({ path })),
})

describe("shellPhase", () => {
  it("reads test, lint, typecheck and build runs as testing", () => {
    for (const line of [
      "pnpm vitest run tests/foo.test.ts",
      "pnpm test",
      "npm run test:unit",
      "yarn lint",
      "pnpm typecheck",
      "pnpm -r build",
      "npx jest --watch=false",
      "pytest -x",
      "cargo test",
      "go test ./...",
      "npx playwright test",
      "tsc --noEmit -p tsconfig.web.json",
      "make check",
    ]) {
      expect(shellPhase(line), line).toBe("testing")
    }
  })

  it("reads look-around commands as exploring", () => {
    for (const line of [
      "ls -la src",
      "cat package.json",
      "rg -n 'foo' src",
      "git status --short",
      "git log --oneline -5",
      "sed -n '1,40p' src/a.ts",
      "find . -name '*.ts'",
    ]) {
      expect(shellPhase(line), line).toBe("exploring")
    }
  })

  it("reads a network probe as verifying and the rest as plain work", () => {
    expect(shellPhase("curl -s localhost:3000/health")).toBe("verifying")
    expect(shellPhase("git commit -m 'x'")).toBe("working")
    expect(shellPhase("pnpm install")).toBe("working")
    expect(shellPhase("mkdir -p out")).toBe("working")
  })

  it("looks through a shell wrapper and a chained read", () => {
    expect(shellPhase("/bin/zsh -lc \"cat a.ts && grep foo b.ts\"")).toBe(
      "exploring",
    )
    expect(shellPhase("cd /p && pnpm vitest run")).toBe("testing")
  })
})

describe("toolPhase", () => {
  it("maps the file tools by name", () => {
    expect(toolPhase("Read")).toBe("exploring")
    expect(toolPhase("Grep")).toBe("exploring")
    expect(toolPhase("Glob")).toBe("exploring")
    expect(toolPhase("list_dir")).toBe("exploring")
    expect(toolPhase("Edit")).toBe("editing")
    expect(toolPhase("Write")).toBe("editing")
    expect(toolPhase("MultiEdit")).toBe("editing")
    expect(toolPhase("apply_patch")).toBe("editing")
    expect(toolPhase("TodoWrite")).toBe("thinking")
  })

  it("classifies a shell tool by the line it runs", () => {
    expect(toolPhase("Bash", "pnpm test")).toBe("testing")
    expect(toolPhase("Bash", "ls")).toBe("exploring")
    expect(toolPhase("Bash", "git push")).toBe("working")
  })

  it("tells the Hub's MCP servers apart from a browser", () => {
    expect(toolPhase("mcp__chat-hub__surface_open")).toBe("verifying")
    expect(toolPhase("mcp__chat-hub__hub_focus_session")).toBe("verifying")
    expect(toolPhase("mcp__chat-hub-browser__browser_click")).toBe("browsing")
    expect(toolPhase("mcp__claude-in-chrome__navigate")).toBe("browsing")
    expect(toolPhase("mcp__chat-hub-browser__browser_screenshot")).toBe(
      "verifying",
    )
  })

  it("counts looking up tools as exploring", () => {
    expect(toolPhase("ToolSearch")).toBe("exploring")
    expect(toolPhase("list_tools")).toBe("exploring")
  })

  it("has no opinion about a tool it has never seen", () => {
    expect(toolPhase("mcp__slack__users_search")).toBe("working")
    expect(toolPhase("Task")).toBe("working")
  })
})

describe("itemPhase and callPhase", () => {
  it("reads the command out of a tool item's arguments", () => {
    expect(itemPhase(tool("t", "Bash", { command: "pnpm lint" }))).toBe("testing")
    expect(itemPhase(shell("c", "cat README.md"))).toBe("exploring")
    expect(itemPhase(edit("e", "src/a.ts"))).toBe("editing")
    expect(itemPhase(reasoning("r", "hmm"))).toBe("thinking")
  })

  it("leaves notices and compactions out of the rail", () => {
    expect(
      itemPhase({ id: "n", kind: "notice", status: "completed", level: "info", title: "x" }),
    ).toBeNull()
    expect(itemPhase({ id: "k", kind: "compaction", status: "completed" })).toBeNull()
  })

  it("classifies a tool fence in the prose the same way", () => {
    const { blocks } = buildTranscript(
      toolUseBlock("Bash", { command: "pnpm vitest run" }, "toolu_a"),
    )
    const call = blocks[0]!.kind === "tools" ? blocks[0]!.calls[0]! : null
    expect(call && callPhase(call)).toBe("testing")
  })
})

describe("testResult", () => {
  it("trusts the exit code over the output", () => {
    expect(testResult(shell("a", "pnpm test", { exitCode: 0, output: "FAIL" })).result).toBe("pass")
    expect(testResult(shell("a", "pnpm test", { exitCode: 1, output: "all good" })).result).toBe("fail")
  })

  it("reads the runner's own words when there is no exit code", () => {
    expect(testResult(shell("a", "pnpm test", { output: "Tests  3 failed | 40 passed" }))).toEqual({
      result: "fail",
      passed: 40,
      failed: 3,
    })
    expect(testResult(shell("a", "pnpm test", { output: "Tests  2427 passed (2427)" }))).toEqual({
      result: "pass",
      passed: 2427,
      failed: null,
    })
    expect(testResult(shell("a", "tsc", { output: "src/a.ts(3,1): error TS2322" })).result).toBe("fail")
    expect(testResult(shell("a", "pnpm test", { output: "✗ renders" })).result).toBe("fail")
  })

  it("does not read '0 failed' as a failure", () => {
    expect(testResult(shell("a", "pnpm test", { output: "12 passed, 0 failed" })).result).toBe("pass")
  })

  it("stays undecided while the run is open and fails a stopped one", () => {
    expect(testResult(shell("a", "pnpm test", { status: "running" })).result).toBeNull()
    expect(testResult(shell("a", "pnpm test", { status: "interrupted" })).result).toBe("fail")
    expect(testResult(tool("t", "Bash", { command: "pnpm test" }, "failed")).result).toBe("fail")
  })
})

describe("buildTurnPhases", () => {
  it("folds consecutive steps of one phase into a counted segment", () => {
    const { segments } = buildTurnPhases([
      tool("1", "Read", { file_path: "a.ts" }),
      tool("2", "Grep", { pattern: "foo" }),
      shell("3", "ls src"),
      edit("4", "a.ts"),
      edit("5", "b.ts"),
      edit("6", "a.ts"),
      shell("7", "pnpm vitest run", { exitCode: 0, output: "Tests  2427 passed" }),
      tool("8", "mcp__chat-hub__surface_open", {}),
    ])
    expect(segments.map((segment) => segment.label)).toEqual([
      "Exploring 3",
      "Editing 2 files",
      "Testing ✓ 2427",
      "Verifying",
    ])
    expect(segments[0]!.count).toBe(3)
    expect(segments[0]!.itemIds).toEqual(["1", "2", "3"])
  })

  it("keeps a thought with the step that follows it instead of splitting the rail", () => {
    const { segments } = buildTurnPhases([
      reasoning("r1", "look at the parser first"),
      tool("1", "Read", { file_path: "a.ts" }),
      reasoning("r2", "and the tests for it"),
      tool("2", "Read", { file_path: "a.test.ts" }),
      reasoning("r3", "the guard is inverted"),
      edit("3", "a.ts"),
    ])
    expect(segments.map((segment) => segment.label)).toEqual([
      "Exploring 2",
      "Editing 1 file",
    ])
    expect(segments[0]!.thought).toBe("and the tests for it")
    expect(segments[1]!.thought).toBe("the guard is inverted")
    expect(segments[0]!.itemIds).toEqual(["r1", "1", "r2", "2"])
  })

  it("shows a trailing thought as its own live Thinking segment", () => {
    const { segments, activeIndex } = buildTurnPhases([
      tool("1", "Read", { file_path: "a.ts" }),
      reasoning("r", "what next", "running"),
    ])
    expect(segments.map((segment) => segment.label)).toEqual(["Exploring", "Thinking"])
    expect(activeIndex).toBe(1)
    expect(segments[1]!.thought).toBe("what next")
  })

  it("marks the segment with an open step as active, and none once settled", () => {
    const running = buildTurnPhases([
      shell("1", "cat a"),
      shell("2", "pnpm test", { status: "running" }),
    ])
    expect(running.activeIndex).toBe(1)
    expect(running.segments[1]!.open).toBe(true)
    expect(running.segments[1]!.label).toBe("Testing")
    expect(running.segments[1]!.test?.result).toBeNull()

    const settled = buildTurnPhases([shell("1", "cat a")])
    expect(settled.activeIndex).toBeNull()
  })

  it("reports a failed test run with the count the runner printed", () => {
    const { segments } = buildTurnPhases([
      shell("1", "pnpm vitest run", { exitCode: 1, output: "Tests  2 failed | 40 passed" }),
      shell("2", "pnpm lint", { exitCode: 0 }),
    ])
    expect(segments).toHaveLength(1)
    expect(segments[0]!.label).toBe("Testing ✗ 2")
    expect(segments[0]!.test).toEqual({ result: "fail", passed: 40, failed: 2 })
  })

  it("says only ✗ when a failed run printed no count", () => {
    const { segments } = buildTurnPhases([
      shell("1", "pnpm typecheck", { exitCode: 2, output: "error TS2322: nope" }),
    ])
    expect(segments[0]!.label).toBe("Testing ✗")
  })

  it("sums the reported durations and leaves them null when none were", () => {
    const timed = buildTurnPhases([
      shell("1", "ls", { durationMs: 120 }),
      shell("2", "cat a", { durationMs: 80 }),
    ])
    expect(timed.segments[0]!.durationMs).toBe(200)
    expect(buildTurnPhases([shell("1", "ls")]).segments[0]!.durationMs).toBeNull()
  })

  it("skips notices without breaking the segment around them", () => {
    const { segments } = buildTurnPhases([
      shell("1", "ls"),
      { id: "n", kind: "notice", status: "completed", level: "info", title: "x" },
      shell("2", "cat a"),
    ])
    expect(segments.map((segment) => segment.label)).toEqual(["Exploring 2"])
  })

  it("is empty for a turn with nothing in it", () => {
    expect(buildTurnPhases(undefined)).toMatchObject({
      segments: [],
      activeIndex: null,
      rail: [],
      railActive: null,
      overview: false,
    })
  })
})

describe("buildTurnPhases blip absorption", () => {
  const surface = (id: string) => tool(id, "mcp__chat-hub__surface_open", {})
  const click = (id: string) => tool(id, "mcp__chat-hub-browser__browser_click", {})

  it("folds a one-step blip into the run around it, keeping every step", () => {
    const { segments } = buildTurnPhases([
      surface("1"),
      surface("2"),
      shell("3", "git commit -m x"),
      surface("4"),
      surface("5"),
    ])
    expect(segments.map((segment) => segment.label)).toEqual(["Verifying 5"])
    expect(segments[0]!.itemIds).toEqual(["1", "2", "3", "4", "5"])
  })

  it("folds two steps only between long runs", () => {
    const long = [click("1"), click("2"), click("3"), click("4")]
    const tail = [click("7"), click("8"), click("9"), click("10")]
    const blip = [shell("5", "git commit"), shell("6", "git push")]
    expect(
      buildTurnPhases([...long, ...blip, ...tail]).segments.map((s) => s.label),
    ).toEqual(["Browsing 10"])
    expect(
      buildTurnPhases([...long.slice(0, 2), ...blip, ...tail]).segments.map((s) => s.label),
    ).toEqual(["Browsing 2", "Working 2", "Browsing 4"])
  })

  it("keeps a blip whose neighbours disagree", () => {
    const { segments } = buildTurnPhases([surface("1"), shell("2", "git push"), click("3")])
    expect(segments.map((segment) => segment.label)).toEqual([
      "Verifying",
      "Working",
      "Browsing",
    ])
  })

  it("keeps absorbing once a merge exposes the next blip", () => {
    const { segments } = buildTurnPhases([
      surface("1"),
      shell("2", "git push"),
      surface("3"),
      click("4"),
      surface("5"),
    ])
    expect(segments.map((segment) => segment.label)).toEqual(["Verifying 5"])
  })

  it("carries an open blip's state into the merged chip", () => {
    const { segments, activeIndex } = buildTurnPhases([
      surface("1"),
      { ...shell("2", "curl x"), status: "running" },
      surface("3"),
    ])
    expect(segments[0]!.open).toBe(true)
    expect(activeIndex).toBe(0)
  })
})

describe("buildTurnPhases overview", () => {
  const surface = (id: string) => tool(id, "mcp__chat-hub__surface_open", {})
  const read = (id: string) => tool(id, "Read", { file_path: `${id}.ts` })
  // Eight alternating runs of two: too many chips to read in sequence.
  const alternating = (runs: number) =>
    Array.from({ length: runs }, (_, run) =>
      run % 2 === 0
        ? [read(`${run}a`), read(`${run}b`)]
        : [surface(`${run}a`), surface(`${run}b`)],
    ).flat()

  it("keeps the sequence up to seven segments", () => {
    const phases = buildTurnPhases(alternating(7))
    expect(phases.overview).toBe(false)
    expect(phases.rail).toBe(phases.segments)
    expect(phases.rail).toHaveLength(7)
  })

  it("totals per phase, in first-seen order, past seven", () => {
    const phases = buildTurnPhases(alternating(8))
    expect(phases.overview).toBe(true)
    expect(phases.segments).toHaveLength(8)
    expect(phases.rail.map((segment) => segment.label)).toEqual([
      "Exploring 8",
      "Verifying 8",
    ])
    expect(phases.rail[0]!.itemIds).toEqual(["0a", "0b", "2a", "2b", "4a", "4b", "6a", "6b"])
  })

  it("points the live chip at the phase the agent is in", () => {
    const items = alternating(8)
    items.push({ ...shell("t", "pnpm test", { output: "1 failed" }), status: "running" })
    const phases = buildTurnPhases(items)
    expect(phases.rail.map((segment) => segment.label)).toEqual([
      "Exploring 8",
      "Verifying 8",
      "Testing",
    ])
    expect(phases.railActive).toBe(2)
    expect(phases.activeIndex).toBe(8)
  })

  it("keeps the test verdict on a totalled chip", () => {
    const items = alternating(8)
    items.splice(4, 0, shell("t1", "pnpm test", { exitCode: 1, output: "2 failed | 9 passed" }))
    items.push(shell("t2", "pnpm test", { exitCode: 0, output: "11 passed" }))
    const phases = buildTurnPhases(items)
    expect(phases.rail.find((segment) => segment.phase === "testing")?.label).toBe(
      "Testing ✗ 2",
    )
  })
})
