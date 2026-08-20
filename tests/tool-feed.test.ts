import { describe, expect, it } from "vitest"
import type { AgentTurnItem, TurnItemStatus } from "@shared/types"
import { toolUseBlock } from "../src/main/adapters/stream-parse"
import {
  groupFeed,
  quietKind,
  runLabel,
  runRange,
  runStatus,
  statusWord,
  stepsFromCalls,
  stepsFromItems,
  type FeedNode,
} from "@renderer/lib/tool-feed"
import { buildTranscript, type ToolCall } from "@renderer/lib/tool-runs"
import { buildTurnTimeline } from "@renderer/lib/turn-timeline"

const PREFIX = "/Users/dev/agent-desktop-suite/chat-hub/src"

function read(
  at: number,
  path: string,
  status: TurnItemStatus = "completed",
): AgentTurnItem {
  return {
    id: `r${at}`,
    kind: "tool",
    status,
    name: "read_file",
    arguments: { file_path: `${PREFIX}/${path}` },
  }
}

function grep(at: number, pattern: string): AgentTurnItem {
  return {
    id: `g${at}`,
    kind: "tool",
    status: "completed",
    name: "grep",
    arguments: { pattern },
  }
}

function edit(at: number, path: string): AgentTurnItem {
  return {
    id: `e${at}`,
    kind: "file_change",
    status: "completed",
    changes: [{ path: `${PREFIX}/${path}`, kind: "edit" }],
  }
}

function twentyReads(): AgentTurnItem[] {
  return Array.from({ length: 20 }, (_, at) =>
    read(at, `main/adapters/file-${at}.ts`),
  )
}

function labels(nodes: FeedNode[]): string[] {
  return nodes.map((node) =>
    node.kind === "run" ? runLabel(node) : node.step.label,
  )
}

function callsOf(src: string): ToolCall[] {
  const block = buildTranscript(src).blocks.find((b) => b.kind === "tools")
  if (!block || block.kind !== "tools") throw new Error("no tool run")
  return block.calls
}

describe("classifying a tool as cheap noise", () => {
  it("knows the read, search and listing tools every CLI spells its own way", () => {
    expect(quietKind("Read")).toBe("read")
    expect(quietKind("read_file")).toBe("read")
    expect(quietKind("Grep")).toBe("grep")
    expect(quietKind("Glob")).toBe("glob")
    expect(quietKind("list_dir")).toBe("list")
    expect(quietKind("WebSearch")).toBe("search")
    expect(quietKind("WebFetch")).toBe("fetch")
  })

  it("keeps writes, commands and anything unknown loud", () => {
    expect(quietKind("Edit")).toBeNull()
    expect(quietKind("Bash")).toBeNull()
    expect(quietKind("mcp__docs__lookup")).toBeNull()
  })
})

describe("grouping a run of twenty reads", () => {
  it("folds them into one row", () => {
    const nodes = groupFeed(stepsFromItems(twentyReads()))
    expect(nodes).toHaveLength(1)
    const [run] = nodes
    expect(run!.kind).toBe("run")
    expect(labels(nodes)).toEqual(["Read 20 files"])
  })

  it("keeps every step, in order, behind the row", () => {
    const [run] = groupFeed(stepsFromItems(twentyReads()))
    if (run!.kind !== "run") throw new Error("expected a run")
    expect(run.steps).toHaveLength(20)
    expect(run.steps.map((step) => step.index)).toEqual(
      Array.from({ length: 20 }, (_, at) => at + 1),
    )
    expect(runRange(run)).toBe("1–20")
  })

  it("numbers the steps exactly as the turn timeline numbers its rows", () => {
    const items = [
      ...twentyReads(),
      grep(1, "onTurnItem"),
      edit(1, "renderer/src/lib/tool-feed.ts"),
    ]
    const steps = stepsFromItems(items)
    const rows = buildTurnTimeline(items).rows
    expect(steps.map((step) => step.index)).toEqual(
      rows.map((row) => row.index),
    )
    expect(steps.map((step) => step.id)).toEqual(rows.map((row) => row.id))
  })

  it("carries the path so the row can drop its head, not its tail", () => {
    const [step] = stepsFromItems([read(0, "main/adapters/grok.ts")])
    expect(step!.path).toBe(`${PREFIX}/main/adapters/grok.ts`)
  })
})

describe("what stays a card of its own", () => {
  it("breaks a run at a write and starts a new one after it", () => {
    const nodes = groupFeed(
      stepsFromItems([
        read(1, "a.ts"),
        read(2, "b.ts"),
        edit(1, "c.ts"),
        read(3, "d.ts"),
      ]),
    )
    expect(labels(nodes)).toEqual(["Read 2 files", "Edit", "Read 1 file"])
  })

  it("never folds a failure into a summary row", () => {
    const nodes = groupFeed(
      stepsFromItems([
        read(1, "a.ts"),
        read(2, "b.ts", "failed"),
        read(3, "c.ts"),
      ]),
    )
    expect(nodes.map((node) => node.kind)).toEqual(["run", "step", "run"])
    expect(labels(nodes)).toEqual(["Read 1 file", "read_file", "Read 1 file"])
  })

  it("keeps a declined step and an error item out of every run", () => {
    const nodes = groupFeed(
      stepsFromItems([
        read(1, "a.ts"),
        { id: "d1", kind: "tool", status: "declined", name: "Read", arguments: {} },
        { id: "x1", kind: "error", status: "failed", message: "docs server 503" },
      ]),
    )
    expect(nodes.map((node) => node.kind)).toEqual(["run", "step", "step"])
  })

  it("does not merge two different cheap kinds standing side by side", () => {
    const nodes = groupFeed(
      stepsFromItems([read(1, "a.ts"), grep(1, "onTurnItem"), grep(2, "items")]),
    )
    expect(labels(nodes)).toEqual(["Read 1 file", "Searched 2 patterns"])
  })

  it("leaves reasoning out of the sequence altogether", () => {
    const steps = stepsFromItems([
      { id: "s1", kind: "reasoning", status: "completed", summary: "why" },
      read(1, "a.ts"),
    ])
    expect(steps.map((step) => step.index)).toEqual([1])
  })
})

describe("the run's own state", () => {
  it("says running while any of its steps is", () => {
    const [run] = groupFeed(
      stepsFromItems([read(1, "a.ts"), read(2, "b.ts", "running")]),
    )
    if (run!.kind !== "run") throw new Error("expected a run")
    expect(runStatus(run)).toBe("running")
    expect(statusWord(runStatus(run))).toBe("running")
  })

  it("stays silent once every step succeeded — the dot already said it", () => {
    expect(statusWord("completed")).toBeNull()
    expect(statusWord("failed")).toBe("failed")
    expect(statusWord("declined")).toBe("declined")
    expect(statusWord("interrupted")).toBe("stopped")
    expect(statusWord("pending")).toBe("queued")
  })
})

describe("the markdown-fence path groups the same way", () => {
  it("folds twenty Read fences into one row", () => {
    const src = Array.from({ length: 20 }, (_, at) =>
      toolUseBlock("Read", { file_path: `${PREFIX}/main/f${at}.ts` }, `t${at}`),
    ).join("")
    const nodes = groupFeed(stepsFromCalls(callsOf(src)))
    expect(labels(nodes)).toEqual(["Read 20 files"])
  })

  it("gives a shell command its own card between two runs of reads", () => {
    const src =
      toolUseBlock("Read", { file_path: "a.ts" }, "t1") +
      toolUseBlock("Bash", { command: "pnpm test" }, "t2") +
      toolUseBlock("Read", { file_path: "b.ts" }, "t3")
    expect(labels(groupFeed(stepsFromCalls(callsOf(src))))).toEqual([
      "Read 1 file",
      "Bash",
      "Read 1 file",
    ])
  })

  it("only calls an unanswered fence running while the turn still is", () => {
    const src = toolUseBlock("Bash", { command: "pnpm test" }, "t1")
    expect(stepsFromCalls(callsOf(src), true)[0]!.status).toBe("running")
    expect(stepsFromCalls(callsOf(src), false)[0]!.status).toBe("completed")
  })
})
