import { describe, expect, it } from "vitest"
import {
  extractTextFromContent,
  extractToolResults,
  toolResultBlock,
  toolUseBlock,
} from "../src/main/adapters/stream-parse"
import { renderCodexItem } from "../src/main/adapters/codex"
import {
  buildTranscript,
  collapseOutput,
  describeCall,
  isFailed,
  startsOpen,
  type ToolCall,
  type TranscriptBlock,
} from "@renderer/lib/tool-runs"
import { matchPath } from "@renderer/lib/path-match"

function runs(blocks: TranscriptBlock[]): ToolCall[][] {
  return blocks
    .filter((b): b is Extract<TranscriptBlock, { kind: "tools" }> =>
      b.kind === "tools",
    )
    .map((b) => b.calls)
}

function firstRun(src: string): ToolCall[] {
  const [run] = runs(buildTranscript(src).blocks)
  if (!run) throw new Error("no tool run in transcript")
  return run
}

describe("pairing a result with its call", () => {
  it("matches on the id both blocks carry", () => {
    const src =
      toolUseBlock("Bash", { command: "pnpm test" }, "toolu_a") +
      toolUseBlock("Bash", { command: "git status" }, "toolu_b") +
      toolResultBlock("Bash", "2 passed", { id: "toolu_b" }) +
      toolResultBlock("Bash", "clean", { id: "toolu_a" })

    const [first, second] = firstRun(src)
    expect(first!.result?.text).toBe("clean")
    expect(second!.result?.text).toBe("2 passed")
  })

  it("falls back to the nearest unanswered call when no id is sent", () => {
    const src =
      "```tool:Bash\n$ one\n```\n" +
      "```tool:Bash\n$ two\n```\n" +
      "```tool-result:Bash\nsecond output\n```\n" +
      "```tool-result:Bash\nfirst output\n```\n"

    const [first, second] = firstRun(src)
    expect(second!.result?.text).toBe("second output")
    expect(first!.result?.text).toBe("first output")
  })

  it("keeps a result whose call never arrived rather than dropping it", () => {
    const calls = firstRun("```tool-result:Bash\nstray\n```\n")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.result?.text).toBe("stray")
    expect(calls[0]!.title).toBe("Bash")
  })

  it("reads a real Claude tool_use / tool_result pair end to end", () => {
    // Field names captured from ~/.claude/projects/*.jsonl on 2026-08-03.
    const assistant = extractTextFromContent([
      { type: "text", text: "Looking." },
      {
        type: "tool_use",
        id: "toolu_01SH5N11BWAUyRc8PeUsDY7s",
        name: "Bash",
        input: { command: "ls -la", description: "List files in project directory" },
      },
    ])
    const user = extractToolResults([
      {
        type: "tool_result",
        tool_use_id: "toolu_01SH5N11BWAUyRc8PeUsDY7s",
        content: "total 64\ndrwxr-xr-x  7 me staff 224 .",
        is_error: false,
      },
    ])

    const [call] = firstRun(assistant + user)
    expect(call!.title).toBe("List files in project directory")
    expect(call!.name).toBe("Bash")
    expect(call!.args).toBe("$ ls -la")
    expect(call!.result?.text).toContain("total 64")
    expect(isFailed(call!)).toBe(false)
  })

  it("marks an is_error result as failed and opens it by default", () => {
    const src =
      toolUseBlock("Bash", { command: "ls missing" }, "toolu_x") +
      extractToolResults([
        {
          type: "tool_result",
          tool_use_id: "toolu_x",
          content: "Exit code 1\nNo such file or directory",
          is_error: true,
        },
      ])
    const [call] = firstRun(src)
    expect(isFailed(call!)).toBe(true)
    expect(startsOpen(call!)).toBe(true)
  })

  it("pairs a codex command with the output riding on the same item", () => {
    // Captured from codex exec --json (codex 0.146.0) on 2026-08-04.
    const ok = renderCodexItem({
      id: "item_2",
      type: "command_execution",
      command: "/bin/zsh -lc 'wc -l a.txt'",
      aggregated_output: "       3 a.txt\n",
      exit_code: 0,
      status: "completed",
    })
    const bad = renderCodexItem({
      id: "item_3",
      type: "command_execution",
      command: "/bin/zsh -lc 'cat nosuchfile.txt'",
      aggregated_output: "cat: nosuchfile.txt: No such file or directory\n",
      exit_code: 1,
      status: "failed",
    })

    const [good, failed] = firstRun(ok + bad)
    expect(good!.result?.text).toContain("3 a.txt")
    expect(isFailed(good!)).toBe(false)
    expect(failed!.result?.exitCode).toBe(1)
    expect(isFailed(failed!)).toBe(true)
    expect(failed!.title).toBe("$ cat nosuchfile.txt")
  })

  it("leaves a still-running codex command unanswered", () => {
    const started = renderCodexItem({
      id: "item_9",
      type: "command_execution",
      command: "sleep 30",
      aggregated_output: "",
      exit_code: null,
      status: "in_progress",
    })
    expect(firstRun(started)[0]!.result).toBeNull()
  })
})

describe("grouping consecutive calls", () => {
  it("groups a run of calls and breaks it on prose", () => {
    const src =
      "Checking things.\n" +
      toolUseBlock("Bash", { command: "one" }, "a") +
      toolResultBlock("Bash", "ok", { id: "a" }) +
      toolUseBlock("Bash", { command: "two" }, "b") +
      toolResultBlock("Bash", "ok", { id: "b" }) +
      "\nNow the answer.\n" +
      toolUseBlock("Bash", { command: "three" }, "c")

    const grouped = runs(buildTranscript(src).blocks)
    expect(grouped.map((r) => r.length)).toEqual([2, 1])
  })

  it("does not let a result or a diff split a run", () => {
    const src =
      toolUseBlock("Edit", { file_path: "/p/a.ts", old_string: "x", new_string: "y" }, "a") +
      toolResultBlock("Edit", "updated", { id: "a" }) +
      toolUseBlock("Bash", { command: "pnpm test" }, "b")
    expect(runs(buildTranscript(src).blocks).map((r) => r.length)).toEqual([2])
  })

  it("breaks a run on a heading, a list and a reasoning block", () => {
    for (const divider of ["## Plan", "- step one", "```thinking\nhm\n```"]) {
      const src =
        toolUseBlock("Bash", { command: "one" }, "a") +
        `\n${divider}\n` +
        toolUseBlock("Bash", { command: "two" }, "b")
      expect(runs(buildTranscript(src).blocks).map((r) => r.length)).toEqual([
        1, 1,
      ])
    }
  })

  it("breaks a run on a mermaid diagram block", () => {
    const src =
      toolUseBlock("Bash", { command: "one" }, "a") +
      "\n```mermaid\nflowchart LR\n  A --> B\n```\n" +
      toolUseBlock("Bash", { command: "two" }, "b")
    const transcript = buildTranscript(src)
    expect(runs(transcript.blocks).map((r) => r.length)).toEqual([1, 1])
    expect(transcript.blocks.some((b) => b.kind === "mermaid")).toBe(true)
  })
})

describe("card titles", () => {
  it("prefers the CLI's own sentence", () => {
    expect(describeCall("Bash", "$ ls -la", { desc: "List the routes" })).toBe(
      "List the routes",
    )
  })

  it("unwraps the shell codex wraps every command in", () => {
    expect(describeCall("Bash", `$ /bin/zsh -lc 'wc -l a.txt'`, {})).toBe(
      "$ wc -l a.txt",
    )
    expect(
      describeCall("Bash", `$ /bin/zsh -lc "sed -n '1,20p' b.txt"`, {}),
    ).toBe("$ sed -n '1,20p' b.txt")
  })

  it("derives a phrase per tool when no description is sent", () => {
    expect(describeCall("Read", "/p/src/schema.prisma", {})).toBe(
      "Read schema.prisma",
    )
    expect(
      describeCall("Edit", "/p/src/queries.ts", {
        paths: ["/p/src/queries.ts"],
        added: 8,
        removed: 3,
      }),
    ).toBe("Edited queries.ts +8 −3")
    expect(describeCall("Grep", "pattern: TODO · in src", {})).toBe(
      "Grep TODO · in src",
    )
  })

  it("says nothing about line counts codex never reported", () => {
    const card = renderCodexItem({
      id: "item_1",
      type: "file_change",
      changes: [{ path: "/p/b.txt", kind: "update" }],
    })
    expect(firstRun(card)[0]!.title).toBe("Edited b.txt")
  })
})

describe("output collapsing", () => {
  it("leaves short output alone", () => {
    const short = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n")
    expect(collapseOutput(short)).toEqual({ head: short, hidden: 0 })
  })

  it("shows the first lines and counts the rest", () => {
    const long = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n")
    const { head, hidden } = collapseOutput(long)
    expect(head.split("\n")).toHaveLength(6)
    expect(hidden).toBe(34)
  })

  it("does not let output containing a fence escape its card", () => {
    const result = toolResultBlock("Read", "before\n```\ncode\n```\nafter")
    const [call] = firstRun(toolUseBlock("Read", { file_path: "/p/a.md" }) + result)
    expect(call!.result?.text).toBe("before\n```\ncode\n```\nafter")
  })
})

describe("changed files for the turn", () => {
  it("tallies the edits and ignores reads and commands", () => {
    const src =
      toolUseBlock("Read", { file_path: "/p/a.ts" }, "r") +
      toolUseBlock("Bash", { command: "pnpm test" }, "s") +
      toolUseBlock(
        "Edit",
        { file_path: "/p/a.ts", old_string: "one\ntwo", new_string: "three" },
        "e1",
      ) +
      toolUseBlock("Write", { file_path: "/p/new.ts", content: "x\ny\nz" }, "e2")

    const { changed } = buildTranscript(src)
    expect(changed.files.map((f) => f.path)).toEqual(["/p/a.ts", "/p/new.ts"])
    expect(changed.added).toBe(4)
    expect(changed.removed).toBe(2)
    expect(changed.countsKnown).toBe(true)
  })

  it("sums repeated edits to one file into a single row", () => {
    const src =
      toolUseBlock("Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }, "1") +
      toolUseBlock("Edit", { file_path: "/p/a.ts", old_string: "c", new_string: "d" }, "2")
    const { changed } = buildTranscript(src)
    expect(changed.files).toEqual([{ path: "/p/a.ts", added: 2, removed: 2 }])
  })

  it("lists a codex file_change without inventing a line count", () => {
    const { changed } = buildTranscript(
      renderCodexItem({
        id: "item_1",
        type: "file_change",
        changes: [{ path: "/p/b.txt", kind: "update" }],
      }),
    )
    expect(changed.files).toEqual([{ path: "/p/b.txt" }])
    expect(changed.countsKnown).toBe(false)
  })

  it("does not credit a turn with a file whose edit failed", () => {
    const src =
      toolUseBlock("Edit", { file_path: "/p/a.ts", old_string: "a", new_string: "b" }, "e") +
      toolResultBlock("Edit", "String to replace not found", {
        id: "e",
        error: true,
      })
    expect(buildTranscript(src).changed.files).toEqual([])
  })

  it("reports nothing for a turn that only read the repo", () => {
    const { changed } = buildTranscript(
      toolUseBlock("Read", { file_path: "/p/a.ts" }, "r"),
    )
    expect(changed.files).toEqual([])
    expect(changed.countsKnown).toBe(false)
  })
})

describe("card keys", () => {
  it("scopes a card key per message, since CLIs reuse call ids per turn", () => {
    const item = renderCodexItem({
      id: "item_0",
      type: "command_execution",
      command: "ls",
      aggregated_output: "a\n",
      exit_code: 0,
      status: "completed",
    })
    const [a] = runs(buildTranscript(item, "msg_1").blocks)[0]!
    const [b] = runs(buildTranscript(item, "msg_2").blocks)[0]!
    expect(a!.key).not.toBe(b!.key)
  })

  it("keeps a key stable as later blocks stream in", () => {
    const first = toolUseBlock("Bash", { command: "one" })
    const before = runs(buildTranscript(first, "m").blocks)[0]![0]!
    const after = runs(
      buildTranscript(first + "\nprose\n" + toolUseBlock("Bash", { command: "two" }), "m")
        .blocks,
    )[0]![0]!
    expect(after.key).toBe(before.key)
  })
})

describe("matching a transcript path to a git row", () => {
  const rows = [{ path: "src/middleware/auth.ts" }, { path: "notes/scratch.md" }]

  it("matches an absolute path against a repo-relative row", () => {
    expect(
      matchPath(rows, (r) => r.path, "/Users/me/proj/src/middleware/auth.ts"),
    ).toEqual(rows[0])
  })

  it("matches an exact relative path", () => {
    expect(matchPath(rows, (r) => r.path, "./notes/scratch.md")).toEqual(rows[1])
  })

  it("returns null when nothing lines up", () => {
    expect(matchPath(rows, (r) => r.path, "src/other.ts")).toBeNull()
    expect(matchPath(rows, (r) => r.path, "")).toBeNull()
  })
})
