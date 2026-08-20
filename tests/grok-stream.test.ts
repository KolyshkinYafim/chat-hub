import { describe, expect, it } from "vitest"
import { GrokActivityStream } from "../src/main/adapters/grok"
import {
  beginAssistant,
  emitTurnItem,
  finishTurn,
  safeJson,
} from "../src/main/adapters/stream-parse"
import type { AdapterCallbacks } from "../src/main/adapters/types"
import type { AgentTurnItem, ChatMessage } from "../src/shared/types"

/**
 * Every line below was captured verbatim from a real
 * `grok --single … --output-format streaming-json` run (grok 1.0.5, 5115b46bc909)
 * on 2026-08-21; only the machine-specific scratch paths were shortened to
 * `/p`. Grok spells its tool fields `toolCallId` / `toolName` / `rawInput`, and
 * every outcome arrives in a separate `tool_call_update` — reading only the
 * flat aliases is what once left the transcript with a nameless "Tool" card
 * stuck on RUNNING.
 */
const READ_AND_SHELL = [
  '{"type":"tool_call","toolCallId":"call-3b278ab8-0","title":"read_file","kind":"read","status":"pending","toolName":"read_file","rawInput":{"target_file":"notes.txt"},"content":[],"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-3b278ab8-0","status":null,"content":[],"rawOutput":null,"locations":[{"path":"notes.txt"}]}',
  '{"type":"tool_call","toolCallId":"call-3b278ab8-1","title":"run_terminal_command","kind":"execute","status":"pending","toolName":"run_terminal_command","rawInput":{"command":"echo hi","description":"Print hi to the shell"},"content":[],"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-3b278ab8-1","status":null,"content":[{"type":"content","content":{"type":"text","text":"Print hi to the shell"}}],"rawOutput":null,"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-3b278ab8-1","status":"in_progress","content":[{"type":"content","content":{"type":"text","text":""}}],"rawOutput":{"type":"Bash","output":[],"output_for_prompt":"","exit_code":0,"command":"echo hi","truncated":false,"signal":null,"timed_out":false,"description":null,"current_dir":"/p","output_file":"","total_bytes":0},"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-3b278ab8-0","status":"completed","content":[{"type":"content","content":{"type":"text","text":"1→hello world\\nsecond line\\n"}}],"rawOutput":{"type":"ReadFile","FileContent":{"content":"1→hello world\\nsecond line\\n","absolute_path":"/p/notes.txt","offset":null,"raw_output":"hello world\\nsecond line\\n","total_lines":3}},"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-3b278ab8-1","status":"in_progress","content":[{"type":"content","content":{"type":"text","text":"hi\\n"}}],"rawOutput":{"type":"Bash","output":[104,105,10],"output_for_prompt":"hi\\n","exit_code":0,"command":"echo hi","truncated":false,"signal":null,"timed_out":false,"description":null,"current_dir":"/p","output_file":"","total_bytes":3},"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-3b278ab8-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"hi\\n"}}],"rawOutput":{"type":"Bash","output":[104,105,10],"output_for_prompt":"exit: 0\\nhi\\n","exit_code":0,"command":"echo hi","truncated":false,"signal":null,"timed_out":false,"description":"Print hi to the shell","current_dir":"/p","output_file":"/p/call.log","total_bytes":3,"was_bare_echo":true},"locations":[]}',
]

/** Same CLI, a run whose command exits non-zero and whose checklist updates. */
const PLAN_AND_FAILURE = [
  '{"type":"tool_call","toolCallId":"call-a19f5666-0","title":"todo_write","kind":"plan","status":"pending","toolName":"todo_write","rawInput":{"todos":[{"id":"1","content":"Run ls /definitely-not-here-xyz","status":"in_progress"},{"id":"2","content":"Report what happened from the command","status":"pending"}],"merge":false},"content":[],"locations":[]}',
  '{"type":"plan","entries":[{"content":"Run ls /definitely-not-here-xyz","priority":"medium","status":"in_progress"},{"content":"Report what happened from the command","priority":"medium","status":"pending"}]}',
  '{"type":"tool_call","toolCallId":"call-a19f5666-1","title":"run_terminal_command","kind":"execute","status":"pending","toolName":"run_terminal_command","rawInput":{"command":"ls /definitely-not-here-xyz","description":"List a path that does not exist"},"content":[],"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-a19f5666-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"ls: /definitely-not-here-xyz: No such file or directory\\n"}}],"rawOutput":{"type":"Bash","output":[108,115],"output_for_prompt":"exit: 1\\nls: /definitely-not-here-xyz: No such file or directory\\n","exit_code":1,"command":"ls /definitely-not-here-xyz","truncated":false,"signal":null,"timed_out":false,"description":"List a path that does not exist","current_dir":"/p","output_file":"/p/call.log","total_bytes":56},"locations":[]}',
  '{"type":"tool_call","toolCallId":"call-a6a61316-2","title":"todo_write","kind":"plan","status":"pending","toolName":"todo_write","rawInput":{"todos":[{"id":"1","status":"completed"},{"id":"2","status":"completed"}],"merge":true},"content":[],"locations":[]}',
  '{"type":"plan","entries":[{"content":"Run ls /definitely-not-here-xyz","priority":"medium","status":"completed"},{"content":"Report what happened from the command","priority":"medium","status":"completed"}]}',
]

/** An edit reports itself as ACP `diff` content blocks, not as tool output. */
const EDIT = [
  '{"type":"tool_call","toolCallId":"call-f35f5812-1","title":"search_replace","kind":"edit","status":"pending","toolName":"search_replace","rawInput":{"file_path":"/p/math.ts","old_string":"export const answer = 42","new_string":"export const answer = 43"},"content":[],"locations":[]}',
  '{"type":"tool_call_update","toolCallId":"call-f35f5812-1","status":"completed","content":[{"type":"diff","path":"/p/math.ts","oldText":"export const answer = 42","newText":"export const answer = 43","_meta":{"old_line":1,"new_line":1}}],"rawOutput":{"type":"SearchReplace","EditsApplied":{"old_string":"export const answer = 42","new_string":"export const answer = 43","absolute_path":"/p/math.ts"}},"locations":[{"path":"/p/math.ts"}]}',
]

/** Grok streams reasoning one word at a time under `thought`. */
const THOUGHTS = [
  '{"type":"thought","data":"The"}',
  '{"type":"thought","data":" user"}',
  '{"type":"thought","data":" wants"}',
  '{"type":"thought","data":" me to read notes.txt."}',
]

function replay(lines: string[]): Map<string, AgentTurnItem> {
  const stream = new GrokActivityStream()
  const items = new Map<string, AgentTurnItem>()
  for (const line of lines) {
    const ev = safeJson(line)
    if (!ev) continue
    const type = String(ev.type ?? "")
    const item =
      type === "thought"
        ? stream.thought(String(ev.data ?? ""))
        : stream.push(ev, type)
    if (item) items.set(item.id, item)
  }
  return items
}

describe("Grok streaming-json activity", () => {
  it("names the tool and keeps the arguments it was called with", () => {
    const read = replay(READ_AND_SHELL).get("grok-call-3b278ab8-0")
    expect(read).toMatchObject({
      kind: "tool",
      name: "read_file",
      status: "completed",
      arguments: { target_file: "notes.txt" },
    })
  })

  it("carries the tool's own result, not an empty object", () => {
    const read = replay(READ_AND_SHELL).get("grok-call-3b278ab8-0")
    expect(read).toMatchObject({ result: "1→hello world\nsecond line\n" })
  })

  it("renders a shell tool as a command card with its output and exit code", () => {
    expect(replay(READ_AND_SHELL).get("grok-call-3b278ab8-1")).toMatchObject({
      kind: "command",
      status: "completed",
      command: "echo hi",
      cwd: "/p",
      output: "hi\n",
      exitCode: 0,
    })
  })

  it("gives every call its own card instead of collapsing them onto one id", () => {
    const items = replay(READ_AND_SHELL)
    expect([...items.keys()]).toEqual([
      "grok-call-3b278ab8-0",
      "grok-call-3b278ab8-1",
    ])
  })

  it("fails a command that exited non-zero, whatever the call's own status says", () => {
    expect(replay(PLAN_AND_FAILURE).get("grok-call-a19f5666-1")).toMatchObject({
      kind: "command",
      status: "failed",
      exitCode: 1,
      output: "ls: /definitely-not-here-xyz: No such file or directory\n",
    })
  })

  it("folds the checklist tool and the plan event into one card", () => {
    const items = replay(PLAN_AND_FAILURE)
    const plans = [...items.keys()].filter((id) => id.includes("plan"))
    expect(plans).toEqual(["grok-plan"])
    expect(items.get("grok-plan")).toMatchObject({
      kind: "plan",
      status: "completed",
      steps: [
        { text: "Run ls /definitely-not-here-xyz", status: "completed" },
        { text: "Report what happened from the command", status: "completed" },
      ],
    })
  })

  it("keeps the last populated checklist when a merge update omits the text", () => {
    // Grok's merge-mode todo_write repeats ids with a status and no content.
    const stream = new GrokActivityStream()
    for (const line of PLAN_AND_FAILURE.slice(0, 2)) stream.push(safeJson(line)!)
    const merged = stream.push(safeJson(PLAN_AND_FAILURE[4]!)!)
    expect(merged).toMatchObject({
      steps: [
        { text: "Run ls /definitely-not-here-xyz" },
        { text: "Report what happened from the command" },
      ],
    })
  })

  it("turns an edit into a file change card carrying the diff", () => {
    const edit = replay(EDIT).get("grok-call-f35f5812-1")
    expect(edit).toMatchObject({
      kind: "file_change",
      status: "completed",
      changes: [{ path: "/p/math.ts", kind: "edit" }],
    })
    const diff = (edit as { changes: { diff?: string }[] }).changes[0]!.diff
    expect(diff).toBe(
      "@@ -1,1 +1,1 @@\n- export const answer = 42\n+ export const answer = 43",
    )
  })

  it("puts the model's own reasoning on the card instead of a placeholder", () => {
    const reasoning = replay(THOUGHTS).get("grok-reasoning")
    expect(reasoning).toMatchObject({
      kind: "reasoning",
      summary: "The user wants me to read notes.txt.",
    })
  })

  it("separates two reasoning bursts split by a tool call", () => {
    const stream = new GrokActivityStream()
    stream.thought("First pass.")
    stream.push(safeJson(READ_AND_SHELL[0]!)!)
    expect(stream.thought("Second pass.")).toMatchObject({
      summary: "First pass.\n\nSecond pass.",
    })
  })

  it("still reads the legacy flat envelope the older CLI emitted", () => {
    const stream = new GrokActivityStream()
    expect(
      stream.push({
        type: "tool_call",
        id: "call-1",
        name: "Read",
        input: { path: "src/a.ts" },
      }),
    ).toMatchObject({
      id: "grok-call-1",
      kind: "tool",
      status: "running",
      name: "Read",
    })
  })
})

describe("a turn ending settles whatever it left open", () => {
  function recorder() {
    const emitted: AgentTurnItem[] = []
    const cb = {
      onMessage: (_m: ChatMessage) => {},
      onDelta: () => {},
      onStreamDone: () => {},
      onSessionEvent: () => {},
      onTurnItem: (_s: string, _m: string, item: AgentTurnItem) => {
        emitted.push(item)
      },
    } as unknown as AdapterCallbacks
    return { cb, emitted }
  }

  it("settles a tool grok never reported back on", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb)
    const stream = new GrokActivityStream()
    const opened = stream.push(safeJson(READ_AND_SHELL[0]!)!)!
    emitTurnItem(turn, "s1", opened, cb)
    expect(opened.status).toBe("running")

    finishTurn(turn, "s1", cb, "completed")
    expect(emitted.at(-1)).toMatchObject({
      id: "grok-call-3b278ab8-0",
      status: "completed",
    })
  })

  it("marks an interrupted turn's open work interrupted, not completed", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb)
    const stream = new GrokActivityStream()
    emitTurnItem(turn, "s1", stream.thought("halfway through")!, cb)
    emitTurnItem(turn, "s1", stream.push(safeJson(READ_AND_SHELL[2]!)!)!, cb)

    finishTurn(turn, "s1", cb, "interrupted")
    const settled = emitted.slice(-2)
    expect(settled.every((item) => item.status === "interrupted")).toBe(true)
  })

  it("leaves an already-settled item alone", () => {
    const { cb, emitted } = recorder()
    const turn = beginAssistant("s1", cb)
    for (const [id, item] of replay(READ_AND_SHELL)) {
      expect(id).toBe(item.id)
      emitTurnItem(turn, "s1", item, cb)
    }
    const before = emitted.length
    finishTurn(turn, "s1", cb, "failed")
    expect(emitted).toHaveLength(before)
  })
})
