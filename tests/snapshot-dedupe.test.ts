import { describe, expect, it } from "vitest"
import {
  beginSnapshotMessage,
  extractTextFromContent,
  newSnapshot,
  noteSnapshotDelta,
  snapshotDelta,
} from "../src/main/adapters/stream-parse"

/**
 * Replays what Claude's stream-json actually sends for a multi-step turn:
 * token deltas per assistant message, then that same message again in full
 * (text + tool_use). `transcript` is what the bubble ends up containing.
 */
function replay(
  messages: { id: string; deltas: string[]; content: unknown[] }[],
  opts?: { partials?: boolean },
): string {
  const snap = newSnapshot()
  let transcript = ""
  for (const m of messages) {
    if (opts?.partials !== false) {
      beginSnapshotMessage(snap, m.id)
      for (const d of m.deltas) {
        transcript += d
        noteSnapshotDelta(snap, d)
      }
    }
    const extra = snapshotDelta(snap, m.id, extractTextFromContent(m.content))
    transcript += extra
  }
  return transcript
}

const checking = {
  id: "msg_1",
  deltas: ["Chec", "king."],
  content: [
    { type: "text", text: "Checking." },
    { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
  ],
}

const editing = {
  id: "msg_2",
  deltas: ["Now editing."],
  content: [
    { type: "text", text: "Now editing." },
    {
      type: "tool_use",
      name: "Edit",
      input: { file_path: "/a.ts", old_string: "old", new_string: "new" },
    },
  ],
}

describe("assistant snapshot dedupe", () => {
  it("keeps every tool card intact across a multi-step turn", () => {
    const out = replay([checking, editing])
    // Each message's own text appears exactly once…
    expect(out.match(/Checking\./g)).toHaveLength(1)
    expect(out.match(/Now editing\./g)).toHaveLength(1)
    // …and both tool cards survive with their fences unbroken. The Edit card
    // also carries its \x1f-marked meta line (paths + line counts), which is
    // what the renderer reads to pair, title and tally the call.
    expect(out).toContain("```tool:Bash\n$ ls -la\n```")
    expect(out).toMatch(
      /```tool:Edit\n\x1f\{"paths":\["\/a\.ts"\],"added":1,"removed":1\}\n\/a\.ts\n```/,
    )
    expect(out).toContain("```diff\n- old\n+ new\n```")
    // The old cumulative-length heuristic sliced INTO the second card.
    expect(out).not.toMatch(/^\s*f\n/m)
  })

  it("does not drop a card just because its message is shorter than the last", () => {
    const long = {
      id: "msg_1",
      deltas: ["x".repeat(400)],
      content: [{ type: "text", text: "x".repeat(400) }],
    }
    const short = {
      id: "msg_2",
      deltas: [] as string[],
      content: [{ type: "tool_use", name: "Read", input: { file_path: "/b.ts" } }],
    }
    expect(replay([long, short])).toContain("```tool:Read\n/b.ts\n```")
  })

  it("emits the whole message when partial streaming is off", () => {
    const out = replay([checking, editing], { partials: false })
    expect(out).toContain("Checking.")
    expect(out).toContain("Now editing.")
    expect(out.match(/```tool:/g)).toHaveLength(2)
  })

  it("never replays a snapshot it has already emitted", () => {
    const snap = newSnapshot()
    beginSnapshotMessage(snap, "msg_1")
    noteSnapshotDelta(snap, "Hello")
    expect(snapshotDelta(snap, "msg_1", "Hello")).toBe("")
    expect(snapshotDelta(snap, "msg_1", "Hello")).toBe("")
  })

  it("treats an id-less stream as one message rather than resetting per event", () => {
    const snap = newSnapshot()
    noteSnapshotDelta(snap, "Hello")
    // No message_start seen: the first snapshot still belongs to these deltas.
    expect(snapshotDelta(snap, undefined, "Hello world")).toBe(" world")
  })
})
