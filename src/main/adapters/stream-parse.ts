import { randomUUID } from "node:crypto"
import {
  encodeToolCardMeta,
  fenceFor,
  isPlanToolName,
  planStepsFromInput,
  type PlanStep,
  type ToolCardMeta,
} from "@shared/tool-card"
import { buildEditDiff } from "./edit-diff"
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

/** The file a tool_use actually wrote/edited, or undefined for reads/searches/etc. */
export function touchedFileFromTool(name: string, input: unknown): string | undefined {
  const lower = name.toLowerCase()
  const touches =
    lower === "write" || lower === "edit" || lower === "multiedit" ||
    lower.includes("str_replace")
  if (!touches) return undefined
  const o = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const file = str(o.file_path) || str(o.path) || str(o.notebook_path)
  return file || undefined
}

/**
 * Files a "write"/"edit"/"multiedit" tool_use block in this content array
 * actually touched — "read"/"bash"/"grep"/"glob" never contribute, so a turn
 * that only inspects the repo never trips an auto-open of the diff panel.
 */
export function extractTouchedFiles(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const files: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    if (b.type !== "tool_use" || typeof b.name !== "string") continue
    const file = touchedFileFromTool(b.name, b.input)
    if (file && !files.includes(file)) files.push(file)
  }
  return files
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
      parts.push(toolUseBlock(b.name, b.input, blockCallId(b)))
    }
    if (b.type === "tool_result") {
      const name = typeof b.name === "string" ? b.name : "result"
      parts.push(
        toolResultBlock(name, toolResultText(b.content), {
          id: blockCallId(b),
          error: b.is_error === true ? true : undefined,
        }),
      )
    }
  }
  return parts.join("")
}

/**
 * Tool results ride in their own `user` envelope, whose content array also
 * carries the human's next prompt — echoing that would duplicate a bubble the
 * transcript already shows, so only the results are rendered here.
 */
export function extractToolResults(content: unknown): string {
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    if (b.type !== "tool_result") continue
    const name = typeof b.name === "string" ? b.name : "result"
    parts.push(
      toolResultBlock(name, toolResultText(b.content), {
        id: blockCallId(b),
        error: b.is_error === true ? true : undefined,
      }),
    )
  }
  return parts.join("")
}

const RESULT_LIMIT = 8000

export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) {
    return content === undefined || content === null
      ? ""
      : JSON.stringify(content)
  }
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
    else if (b.type === "image") parts.push("[image]")
    else parts.push(JSON.stringify(b))
  }
  return parts.join("\n")
}

export function toolResultBlock(
  name: string,
  content: string,
  meta: ToolCardMeta = {},
): string {
  const trimmed =
    content.length > RESULT_LIMIT
      ? `${content.slice(0, RESULT_LIMIT)}\n… (${content.length - RESULT_LIMIT} more characters)`
      : content
  const body = `${encodeToolCardMeta(meta)}${trimmed}`
  const fence = fenceFor(body)
  return `\n\n${fence}tool-result:${name}\n${body}\n${fence}\n\n`
}

function blockCallId(b: Record<string, unknown>): string | undefined {
  if (typeof b.tool_use_id === "string") return b.tool_use_id
  if (typeof b.id === "string") return b.id
  return undefined
}

// The metadata rides as a \x1f-marked first line so the renderer can title the
// card with the CLI's own sentence and pair a result to the call that made it;
// a CLI that sends none of it just falls back to the command/args as before.
export function toolCallBlock(
  name: string,
  head: string,
  meta: ToolCardMeta = {},
): string {
  const body = `${encodeToolCardMeta(meta)}${head || "(no args)"}`
  const fence = fenceFor(body)
  return `\n\n${fence}tool:${name}\n${body}\n${fence}\n\n`
}

/** Render a tool_use as a readable tool card (+ diff block for file edits). */
export function toolUseBlock(
  name: string,
  input: unknown,
  id?: string,
): string {
  const { head, diff, paths, added, removed, absLines, plan } =
    summarizeToolInput(name, input)
  const card = toolCallBlock(name, head, {
    id,
    desc: descriptionOf(input),
    paths,
    added,
    removed,
    absLines,
    plan,
  })
  if (!diff || !diff.trim()) return card
  return `${card}\`\`\`diff\n${diff}\n\`\`\`\n\n`
}

/** A CLI-supplied natural-language label for the call, when present. */
function descriptionOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const d = (input as Record<string, unknown>).description
  if (typeof d !== "string" || !d.trim()) return undefined
  // The description rides as ONE \x1f-marked line; collapse any internal newlines
  // so a multi-line description can't be truncated by splitToolDesc.
  return d.trim().replace(/\s*\n\s*/g, " ")
}

type ToolSummary = {
  head: string
  diff?: string
  paths?: string[]
  added?: number
  removed?: number
  absLines?: true
  plan?: PlanStep[]
}

function summarizeToolInput(name: string, input: unknown): ToolSummary {
  const o = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const file = str(o.file_path) || str(o.path) || str(o.notebook_path)
  const lower = name.toLowerCase()

  // Claude TodoWrite / Codex update_plan — structured checklist, not raw JSON.
  if (isPlanToolName(name)) {
    const plan = planStepsFromInput(input)
    const active =
      plan.find((s) => s.status === "in_progress") ??
      plan.find((s) => s.status === "pending")
    const head =
      active?.text ||
      (plan.length > 0 ? `${plan.length} steps` : planHeadFallback(input))
    return { head: head.slice(0, 200), plan: plan.length > 0 ? plan : undefined }
  }

  if (lower === "bash") {
    const cmd = str(o.command).split("\n")[0] ?? ""
    return { head: `$ ${cmd}`.slice(0, 200) }
  }
  if (lower === "write") {
    return { head: file, ...editSummary(file, [["", str(o.content)]]) }
  }
  if (lower === "edit" || lower.includes("str_replace")) {
    return {
      head: file,
      ...editSummary(file, [[str(o.old_string), str(o.new_string)]]),
    }
  }
  if (lower === "multiedit" && Array.isArray(o.edits)) {
    const edits = o.edits as Record<string, unknown>[]
    return {
      head: `${file} · ${edits.length} edits`,
      ...editSummary(
        file,
        edits.map((e) => [str(e.old_string), str(e.new_string)]),
      ),
    }
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

function planHeadFallback(input: unknown): string {
  if (!input || typeof input !== "object") return "Plan"
  const o = input as Record<string, unknown>
  if (typeof o.explanation === "string" && o.explanation.trim()) {
    return o.explanation.trim()
  }
  return "Plan"
}

function editSummary(
  file: string,
  pairs: [string, string][],
): Pick<ToolSummary, "diff" | "paths" | "added" | "removed" | "absLines"> {
  // The card is built from the call's own payload, never from git — a folder
  // that is not a repo still gets a real diff. Reading the file here (before
  // the edit lands) is only for honest line numbers; without it the hunks are
  // numbered from 1 and the card says so.
  const { text, added, removed, absoluteLines } = buildEditDiff(
    file,
    pairs.map(([oldText, newText]) => ({ oldText, newText })),
  )
  return {
    diff: text,
    paths: file ? [file] : undefined,
    added,
    removed,
    absLines: absoluteLines ? true : undefined,
  }
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
