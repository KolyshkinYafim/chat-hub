import { randomUUID } from "node:crypto"
import type { AdapterCallbacks } from "./types"

/** Shared helpers for NDJSON CLI streams → transcript callbacks. */

export type StreamTurn = {
  messageId: string
  started: boolean
  text: string
}

export function beginAssistant(
  sessionId: string,
  cb: AdapterCallbacks,
): StreamTurn {
  const messageId = randomUUID()
  cb.onMessage({
    id: messageId,
    sessionId,
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    streaming: true,
  })
  return { messageId, started: true, text: "" }
}

export function pushDelta(
  turn: StreamTurn,
  sessionId: string,
  delta: string,
  cb: AdapterCallbacks,
): void {
  if (!delta) return
  turn.text += delta
  cb.onDelta(sessionId, turn.messageId, delta)
}

export function finishTurn(
  turn: StreamTurn | null,
  sessionId: string,
  cb: AdapterCallbacks,
): string {
  if (!turn) return ""
  cb.onStreamDone(sessionId, turn.messageId)
  if (turn.text.trim()) {
    cb.onSessionEvent({
      type: "session.message",
      id: sessionId,
      role: "assistant",
      preview: turn.text.replace(/\s+/g, " ").slice(0, 160),
    })
  }
  return turn.text
}

/**
 * Dedupe state for CLIs that stream token deltas AND re-send each finished
 * assistant message in full. One run contains many such messages, so the diff
 * baseline is per message — comparing a single message's rendering against the
 * whole run's buffer slices it at a meaningless offset.
 */
export type SnapshotState = { messageId?: string; emitted: string }

export function newSnapshot(): SnapshotState {
  return { emitted: "" }
}

/** A new assistant message started streaming — reset its baseline. */
export function beginSnapshotMessage(
  s: SnapshotState,
  messageId: string | undefined,
): void {
  s.messageId = messageId
  s.emitted = ""
}

/** Token delta that belongs to the message currently being tracked. */
export function noteSnapshotDelta(s: SnapshotState, delta: string): void {
  s.emitted += delta
}

/** What of a full-message snapshot still has to be appended to the transcript. */
export function snapshotDelta(
  s: SnapshotState,
  messageId: string | undefined,
  text: string,
): string {
  if (messageId !== s.messageId) {
    // Only reset once ids are actually being tracked: without a message_start
    // the deltas already in `emitted` belong to this very snapshot.
    if (s.messageId !== undefined) s.emitted = ""
    s.messageId = messageId
  }
  // Deltas carry text blocks only; the snapshot adds tool cards after them.
  const extra = text.startsWith(s.emitted) ? text.slice(s.emitted.length) : text
  s.emitted = text
  return extra
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
    if (b.type === "tool_use" && typeof b.name === "string") {
      parts.push(toolUseBlock(b.name, b.input))
    }
    if (b.type === "tool_result") {
      const content =
        typeof b.content === "string"
          ? b.content.slice(0, 500)
          : JSON.stringify(b.content ?? "").slice(0, 500)
      const name = typeof b.name === "string" ? b.name : "result"
      parts.push(`\n\n\`\`\`tool-result:${name}\n${content}\n\`\`\`\n\n`)
    }
  }
  return parts.join("")
}

/** Render a tool_use as a readable tool card (+ diff block for file edits). */
export function toolUseBlock(name: string, input: unknown): string {
  const { head, diff } = summarizeToolInput(name, input)
  const desc = descriptionOf(input)
  // The description rides as a \x1f-marked first line so the renderer can title
  // the card with it (matching how Claude labels each Bash call); a CLI that
  // sends no description just falls back to the command/args as before.
  const body = desc ? `\x1f${desc}\n${head || "(no args)"}` : head || "(no args)"
  let out = `\n\n\`\`\`tool:${name}\n${body}\n\`\`\`\n`
  if (diff && diff.trim()) out += `\n\`\`\`diff\n${diff}\n\`\`\`\n`
  return out + "\n"
}

/** A CLI-supplied natural-language label for the call, when present. */
function descriptionOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const d = (input as Record<string, unknown>).description
  return typeof d === "string" && d.trim() ? d.trim() : undefined
}

function summarizeToolInput(
  name: string,
  input: unknown,
): { head: string; diff?: string } {
  const o = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const file = str(o.file_path) || str(o.path) || str(o.notebook_path)
  const lower = name.toLowerCase()

  if (lower === "bash") {
    const cmd = str(o.command).split("\n")[0] ?? ""
    return { head: `$ ${cmd}`.slice(0, 200) }
  }
  if (lower === "write") {
    return { head: file, diff: makeDiff("", str(o.content)) }
  }
  if (lower === "edit" || lower.includes("str_replace")) {
    return { head: file, diff: makeDiff(str(o.old_string), str(o.new_string)) }
  }
  if (lower === "multiedit" && Array.isArray(o.edits)) {
    const edits = o.edits as Record<string, unknown>[]
    const chunks = edits
      .slice(0, 6)
      .map((e) => makeDiff(str(e.old_string), str(e.new_string)))
      .filter(Boolean)
    return { head: `${file} · ${edits.length} edits`, diff: chunks.join("\n") }
  }
  if (lower === "read") return { head: file }
  if (lower === "grep") {
    return {
      head: `pattern: ${str(o.pattern)}${o.path ? ` · in ${str(o.path)}` : ""}`,
    }
  }
  if (lower === "glob") return { head: `glob: ${str(o.pattern)}` }
  if (file) return { head: file }

  const json = JSON.stringify(o)
  return { head: json.length > 2 ? json.slice(0, 200) : "(no args)" }
}

function makeDiff(oldS: string, newS: string, maxLines = 40): string {
  const out: string[] = []
  if (oldS) for (const l of oldS.split("\n")) out.push(`- ${l}`)
  if (newS) for (const l of newS.split("\n")) out.push(`+ ${l}`)
  if (out.length > maxLines) {
    const extra = out.length - maxLines
    return `${out.slice(0, maxLines).join("\n")}\n… (${extra} more lines)`
  }
  return out.join("\n")
}

export function safeJson(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown
    // Arrays are `typeof "object"` too, but callers index by key — returning one
    // would hand back a value that silently answers `undefined` to every lookup.
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}
