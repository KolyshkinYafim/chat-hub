import { describe, expect, it } from "vitest"
import { buildCodexArgs } from "../src/main/adapters/args"
import {
  currentCodexModel,
  mapThreadItem,
  renderCodexItem,
  selectCompatibleEffort,
} from "../src/main/adapters/codex"
import { readUsage } from "../src/main/adapters/usage"
import {
  beginAssistant,
  emitTurnItem,
  finishTurn,
  safeJson,
} from "../src/main/adapters/stream-parse"
import type { ThreadItem } from "../src/main/codex-protocol/generated/v2/ThreadItem"
import type { AdapterCallbacks } from "../src/main/adapters/types"
import type { AgentTurnItem } from "../src/shared/types"

/**
 * Every expectation here was captured from a real `codex exec --json` run
 * (codex-cli 0.146.0-alpha.9.2, /Applications/ChatGPT.app/Contents/Resources/codex)
 * on 2026-08-02. When a codex upgrade changes the shape, this suite is what
 * tells us — instead of the transcript quietly filling with raw JSON again.
 */
const REAL_TURN = [
  '{"type":"thread.started","thread_id":"019fc287-2011-73f1-b931-fb0a2d91a646"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I\'ll create `note.txt`."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/p/note.txt","kind":"add"}],"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/p/note.txt","kind":"add"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE"}}',
  '{"type":"turn.completed","usage":{"input_tokens":34054,"cached_input_tokens":27136,"cache_write_input_tokens":0,"output_tokens":79,"reasoning_output_tokens":12}}',
]

describe("buildCodexArgs", () => {
  it("does not send model ids retired from the Codex picker", () => {
    expect(currentCodexModel("gpt-5-codex")).toBeNull()
    expect(currentCodexModel("o4-mini")).toBeNull()
    expect(currentCodexModel("gpt-5.6-sol")).toBe("gpt-5.6-sol")
  })

  it("falls back when a model does not support the selected reasoning effort", () => {
    const luna = new Set(["low", "medium", "high", "xhigh", "max"])
    expect(selectCompatibleEffort("ultra", luna, "medium")).toBe("medium")
    expect(selectCompatibleEffort("xhigh", luna, "medium")).toBe("xhigh")
  })

  it("asks for JSONL and tolerates a non-repo folder", () => {
    const args = buildCodexArgs({ message: "hi", cwd: "/p", permissionMode: "yolo" })
    expect(args).toContain("--json")
    expect(args).toContain("--skip-git-repo-check")
    expect(args.slice(0, 2)).toEqual(["exec", "hi"])
    expect(args.join(" ")).toContain("--cd /p")
  })

  it("uses the real bypass flag, not the deprecated --full-auto", () => {
    const args = buildCodexArgs({ message: "hi", cwd: "/p", permissionMode: "yolo" })
    // --full-auto only means `--sandbox workspace-write`, so the "full access"
    // chip would have been a lie.
    expect(args).not.toContain("--full-auto")
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox")
  })

  it("maps the non-YOLO modes onto sandbox levels", () => {
    expect(
      buildCodexArgs({ message: "hi", cwd: "/p", permissionMode: "acceptEdits" }).join(" "),
    ).toContain("--sandbox workspace-write")
    expect(
      buildCodexArgs({ message: "hi", cwd: "/p", permissionMode: "default" }).join(" "),
    ).toContain("--sandbox read-only")
  })

  it("resumes a thread and passes none of the flags resume rejects", () => {
    const args = buildCodexArgs({
      message: "and now?",
      cwd: "/p",
      permissionMode: "yolo",
      resumeId: "019fc287-2011-73f1-b931-fb0a2d91a646",
    })
    expect(args.slice(0, 4)).toEqual([
      "exec",
      "resume",
      "019fc287-2011-73f1-b931-fb0a2d91a646",
      "and now?",
    ])
    // `exec resume` errors with "unexpected argument '-C' found" on any of these.
    expect(args).not.toContain("--cd")
    expect(args).not.toContain("--sandbox")
    expect(args).toContain("--json")
  })

  it("keeps a resumed non-YOLO turn on the CLI default rather than a rejected flag", () => {
    const args = buildCodexArgs({
      message: "x",
      cwd: "/p",
      permissionMode: "default",
      resumeId: "t1",
    })
    expect(args).not.toContain("--sandbox")
  })

  it("folds attachments into the prompt", () => {
    const args = buildCodexArgs({
      message: "review",
      cwd: "/p",
      permissionMode: "yolo",
      attachments: ["/p/a.ts"],
    })
    expect(args[1]).toContain("@/p/a.ts")
  })
})

describe("renderCodexItem", () => {
  it("renders an agent message as plain text", () => {
    expect(renderCodexItem({ type: "agent_message", text: "DONE" })).toBe("DONE")
  })

  it("keeps reasoning out of the transcript", () => {
    expect(renderCodexItem({ type: "reasoning", text: "thinking…" })).toBe("")
  })

  it("renders a single file change as an Edit card", () => {
    const out = renderCodexItem({
      type: "file_change",
      changes: [{ path: "/p/note.txt", kind: "add" }],
    })
    expect(out).toContain("```tool:Edit")
    expect(out).toContain("/p/note.txt")
  })

  it("lists every path when one item changed several files", () => {
    const out = renderCodexItem({
      type: "file_change",
      changes: [
        { path: "/p/a.ts", kind: "add" },
        { path: "/p/b.ts", kind: "modify" },
      ],
    })
    expect(out).toContain("add /p/a.ts")
    expect(out).toContain("modify /p/b.ts")
  })

  it("renders a command as a Bash card", () => {
    const out = renderCodexItem({ type: "command_execution", command: "npm test" })
    expect(out).toContain("```tool:Bash")
    expect(out).toContain("$ npm test")
  })

  it("renders a todo list as a plan tool card", () => {
    const out = renderCodexItem({
      type: "todo_list",
      items: [
        { text: "write it", completed: true },
        { text: "ship it", completed: false },
      ],
    })
    expect(out).toContain("```tool:TodoWrite")
    expect(out).toContain('"plan"')
    expect(out).toContain("write it")
    expect(out).toContain("ship it")
    expect(out).not.toContain("- [x]")
  })

  it("surfaces an error item instead of dropping it", () => {
    expect(renderCodexItem({ type: "error", message: "rate limited" })).toContain(
      "rate limited",
    )
  })

  it("still shows an unknown item type as a card", () => {
    // codex adds item types between releases; silence would hide real work.
    const out = renderCodexItem({ type: "brand_new_thing", detail: "x" })
    expect(out).toContain("```tool:brand_new_thing")
  })
})

describe("a real codex turn end to end", () => {
  it("yields the thread id, both messages, one tool card and the usage", () => {
    let threadId: string | undefined
    const parts: string[] = []
    let usage: ReturnType<typeof readUsage> = null

    for (const line of REAL_TURN) {
      const ev = safeJson(line)
      expect(ev).not.toBeNull()
      if (!ev) continue
      usage = readUsage(ev) ?? usage
      if (ev.type === "thread.started") {
        threadId = ev.thread_id as string
        continue
      }
      if (ev.type !== "item.completed") continue
      const rendered = renderCodexItem(ev.item as Record<string, unknown>)
      if (rendered) parts.push(rendered)
    }

    expect(threadId).toBe("019fc287-2011-73f1-b931-fb0a2d91a646")
    // item.started must not double the file_change card.
    expect(parts).toHaveLength(3)
    expect(parts[0]).toContain("note.txt")
    expect(parts[1]).toContain("```tool:Edit")
    expect(parts[2]).toBe("DONE")

    expect(usage).toEqual({
      inputTokens: 34054,
      outputTokens: 79,
      cacheReadTokens: 27136,
      cacheCreateTokens: 0,
    })
  })
})

/**
 * Captured verbatim from a real `codex app-server` session (codex-cli
 * 0.148.0-alpha.21, /Applications/ChatGPT.app/Contents/Resources/codex) on
 * 2026-08-21; only the scratch cwd was shortened to `/p`. The second item is
 * the one the user interrupted: codex sends `item/started` for it and then
 * `turn/completed` with status "interrupted" — no `item/completed` ever
 * arrives, so the card settles only if the turn's end settles it.
 */
const REAL_COMMAND_ITEM = {
  type: "commandExecution",
  id: "exec-9bd2010c-24a4-420d-b29e-4a96277f8026",
  pluginId: null,
  scriptPath: null,
  command: "/bin/zsh -lc \"sed -n '2p' notes.txt && echo hi\"",
  cwd: "/p",
  processId: "10528",
  source: "unifiedExecStartup",
  status: "completed",
  commandActions: [{ type: "unknown", command: "sed -n '2p' notes.txt && echo hi" }],
  aggregatedOutput: "second line\nhi\n",
  exitCode: 0,
  durationMs: 0,
} as unknown as ThreadItem

const REAL_INTERRUPTED_ITEM = {
  type: "commandExecution",
  id: "exec-c72a7fc5-800f-487b-9171-6ddd561c3737",
  pluginId: null,
  scriptPath: null,
  command: "/bin/zsh -lc 'sleep 45 && echo done'",
  cwd: "/p",
  processId: "19978",
  source: "unifiedExecStartup",
  status: "inProgress",
  commandActions: [{ type: "unknown", command: "sleep 45 && echo done" }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
} as unknown as ThreadItem

const REAL_REASONING_ITEM = {
  type: "reasoning",
  id: "rs_02a8b71fecd86eed016a877f616d8487d09d7ca684109d63c0",
  summary: ["**Confirming tool unavailability**"],
  content: [],
} as unknown as ThreadItem

describe("codex app-server thread items", () => {
  function recorder() {
    const emitted: AgentTurnItem[] = []
    const cb = {
      onMessage: () => {},
      onDelta: () => {},
      onStreamDone: () => {},
      onSessionEvent: () => {},
      onTurnItem: (_s: string, _m: string, item: AgentTurnItem) => {
        emitted.push(item)
      },
    } as unknown as AdapterCallbacks
    return { cb, emitted }
  }

  it("keeps a finished command's own output, exit code and duration", () => {
    expect(mapThreadItem(REAL_COMMAND_ITEM, true)).toMatchObject({
      kind: "command",
      status: "completed",
      command: "/bin/zsh -lc \"sed -n '2p' notes.txt && echo hi\"",
      cwd: "/p",
      output: "second line\nhi\n",
      exitCode: 0,
    })
  })

  it("carries the model's reasoning summary rather than a placeholder", () => {
    expect(mapThreadItem(REAL_REASONING_ITEM, true)).toMatchObject({
      kind: "reasoning",
      status: "completed",
      summary: "**Confirming tool unavailability**",
    })
  })

  it("settles the command an interrupted turn never reported back on", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb)
    const running = mapThreadItem(REAL_INTERRUPTED_ITEM, false)!
    expect(running.status).toBe("running")
    emitTurnItem(turn, "s1", running, cb)

    finishTurn(turn, "s1", cb, "interrupted")
    expect(emitted.at(-1)).toMatchObject({
      id: "exec-c72a7fc5-800f-487b-9171-6ddd561c3737",
      kind: "command",
      status: "interrupted",
    })
  })

  it("settles the synthetic plan and diff cards a turn opens and never closes", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb)
    emitTurnItem(turn, "s1", {
      id: "turn-plan",
      kind: "plan",
      status: "running",
      text: "Plan",
      steps: [{ text: "read the file", status: "running" }],
    }, cb)
    emitTurnItem(turn, "s1", {
      id: "turn-diff",
      kind: "file_change",
      status: "running",
      changes: [],
      aggregateDiff: "--- a\n+++ b\n",
    }, cb)

    finishTurn(turn, "s1", cb, "completed")
    expect(emitted.slice(-2).map((item) => [item.id, item.status])).toEqual([
      ["turn-plan", "completed"],
      ["turn-diff", "completed"],
    ])
  })
})
