import type { ChatMessage } from "@shared/types"
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
    if (!m.content) continue
    const { blocks } = buildTranscript(m.content, m.id)
    for (const block of blocks) {
      if (block.kind !== "tools") continue
      for (const call of block.calls) {
        out.push(toAction(call, m.id))
      }
    }
  }
  if (out.length <= limit) return out
  return out.slice(out.length - limit)
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
