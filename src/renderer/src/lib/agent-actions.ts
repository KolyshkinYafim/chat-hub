import type { AgentTurnItem, ChatMessage } from "@shared/types"
import { hashDiff } from "@shared/diff-hash"
import {
  buildTranscript,
  isFailed,
  type ToolCall,
} from "./tool-runs"

/** One tool the agent ran — for the Diff surface audit trail. */
export type AgentAction = {
  key: string
  name: string
  /** Short human line: "Read foo.ts", "$ pnpm test", … */
  summary: string
  status: "ok" | "error" | "running"
  exitCode?: number
  paths?: string[]
  messageId: string
}

export type MessageEditSignal = {
  /** Paths in first-seen order; the last one is the most recent focus target. */
  paths: string[]
  /** Changes when an in-flight edit gains a patch or settles. */
  revision: string
}

const DEFAULT_LIMIT = 40

/**
 * Walk the session transcript and collect tool calls in chronological order.
 * Uses the same pairing as the chat cards (`buildTranscript`) — does not
 * invent a second source of truth for touched files.
 */
export function collectAgentActions(
  messages: ChatMessage[],
  limit = DEFAULT_LIMIT,
): AgentAction[] {
  const out: AgentAction[] = []
  for (const m of messages) {
    if (m.role !== "assistant") continue
    if (m.content) {
      const { blocks } = buildTranscript(m.content, m.id)
      for (const block of blocks) {
        if (block.kind !== "tools") continue
        for (const call of block.calls) {
          out.push(toAction(call, m.id))
        }
      }
    }
    // Codex (and newer adapters) report real-time activity as structured items
    // rather than synthetic Markdown. The audit trail must not make those turns
    // look idle simply because there is no ```tool fence in the prose.
    for (const item of m.items ?? []) {
      const action = actionFromItem(item, m.id)
      if (action) out.push(action)
    }
  }
  if (out.length <= limit) return out
  return out.slice(out.length - limit)
}

/**
 * Paths this assistant turn has written to so far, from the same parse the
 * transcript cards use. Reads, searches and shell calls never contribute.
 */
export function editSignalInMessage(
  message: ChatMessage,
): MessageEditSignal | null {
  const paths: string[] = []
  const revisions: string[] = []
  const add = (path: string) => {
    if (path && !paths.includes(path)) paths.push(path)
  }
  if (message.content) {
    const { blocks, changed } = buildTranscript(message.content, message.id)
    for (const file of changed.files) add(file.path)
    for (const block of blocks) {
      if (block.kind !== "tools") continue
      for (const call of block.calls) {
        if (!call.meta.paths?.length || isFailed(call)) continue
        revisions.push(
          [
            call.key,
            call.result === null ? "running" : "settled",
            call.diff ?? "",
            call.meta.paths.join("\u0000"),
          ].join("\u0001"),
        )
      }
    }
  }
  for (const item of message.items ?? []) {
    if (item.kind !== "file_change") continue
    for (const change of item.changes) add(change.path)
    for (const path of pathsInUnifiedDiff(item.aggregateDiff ?? "")) add(path)
    revisions.push(
      [
        item.id,
        item.status,
        item.aggregateDiff ?? "",
        ...item.changes.flatMap((change) => [
          change.path,
          change.kind ?? "",
          change.diff ?? "",
        ]),
      ].join("\u0001"),
    )
  }
  if (revisions.length === 0) return null
  return { paths, revision: hashDiff(revisions.join("\u0002")) }
}

/** Paths this assistant turn has written to so far. */
export function editedPathsInMessage(message: ChatMessage): string[] {
  return editSignalInMessage(message)?.paths ?? []
}

/**
 * Codex can publish a live aggregate patch before its per-file change item.
 * Pull its paths from ordinary git headers so that preview can open immediately.
 */
function pathsInUnifiedDiff(text: string): string[] {
  const out: string[] = []
  const add = (path: string) => {
    const clean = path.replace(/^[ab]\//, "")
    if (clean && clean !== "/dev/null" && !out.includes(clean)) out.push(clean)
  }
  for (const line of text.split("\n")) {
    const git = /^diff --git (?:"?a\/.*?"?) (?:"?b\/(.*?)"?)$/.exec(line)
    if (git?.[1]) {
      add(git[1])
      continue
    }
    if (line.startsWith("+++ ")) add(line.slice(4).trim().replace(/^"|"$/g, ""))
  }
  return out
}

function actionFromItem(item: AgentTurnItem, messageId: string): AgentAction | null {
  const base = {
    key: `${messageId}/item-${item.id}`,
    status: actionStatus(item.status),
    messageId,
  } as const
  switch (item.kind) {
    case "command":
      return {
        ...base,
        name: "Command",
        summary: `$ ${firstLine(item.command)}`,
        exitCode: item.exitCode,
      }
    case "file_change": {
      const paths = item.changes.map((change) => change.path).filter(Boolean)
      return {
        ...base,
        name: "File change",
        summary: paths.length === 1 ? `Changed ${baseName(paths[0]!)}` : `Changed ${paths.length} files`,
        paths,
      }
    }
    case "tool":
      return {
        ...base,
        name: item.name,
        summary: item.server ? `${item.server} · ${item.name}` : item.name,
      }
    case "subagent":
      return {
        ...base,
        name: "Subagent",
        summary: `${item.name} agent · ${item.description || `${item.steps?.length ?? 0} steps`}`,
      }
    case "web_search":
      return { ...base, name: "Web search", summary: `Search ${item.query}` }
    case "image":
      return { ...base, name: "Image view", summary: `Viewed ${baseName(item.path)}`, paths: [item.path] }
    case "plan":
      return { ...base, name: "Plan", summary: item.text || "Updated plan" }
    case "review":
      return { ...base, name: "Review", summary: item.text || "Review" }
    case "notice":
      return {
        ...base,
        name: item.level === "warning" ? "Warning" : "Note",
        summary: item.title,
        ...(item.level === "warning" ? { status: "error" as const } : {}),
      }
    case "error":
      return { ...base, name: "Error", summary: item.message, status: "error" }
    case "reasoning":
    case "compaction":
      return null
    // An item kind this build does not know is not an audit-trail entry.
    default:
      return null
  }
}

function actionStatus(status: AgentTurnItem["status"]): AgentAction["status"] {
  if (status === "failed" || status === "declined" || status === "interrupted") return "error"
  if (status === "pending" || status === "running") return "running"
  return "ok"
}

function toAction(call: ToolCall, messageId: string): AgentAction {
  const status: AgentAction["status"] =
    call.result === null ? "running" : isFailed(call) ? "error" : "ok"
  const action: AgentAction = {
    key: call.key,
    name: call.name,
    summary: call.title,
    status,
    messageId,
  }
  if (call.result?.exitCode !== undefined) action.exitCode = call.result.exitCode
  if (call.meta.paths && call.meta.paths.length > 0) action.paths = call.meta.paths
  return action
}

/**
 * Best-effort: which recent action last touched this path.
 * Returns null when nothing in the trail mentions the path — callers must not
 * invent a link.
 */
export function actionForPath(
  actions: AgentAction[],
  path: string,
): AgentAction | null {
  if (!path) return null
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const a = actions[i]!
    if (!a.paths) continue
    if (a.paths.some((p) => pathsMatch(p, path))) return a
  }
  return null
}

function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true
  // Repo-relative vs absolute: match on suffix.
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? ""
}

function baseName(path: string): string {
  const clean = path.split(" · ")[0]!.trim()
  const parts = clean.split("/")
  return parts[parts.length - 1] || clean
}
