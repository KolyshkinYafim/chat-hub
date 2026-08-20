/** One step of a Claude TodoWrite / Codex update_plan checklist. */
export type PlanStepStatus = "pending" | "in_progress" | "completed"

export type PlanStep = {
  text: string
  status: PlanStepStatus
}

export type ToolCardMeta = {
  id?: string
  desc?: string
  paths?: string[]
  added?: number
  removed?: number
  exitCode?: number
  error?: boolean
  absLines?: true
  /** Present on plan tools — drives the checklist card instead of JSON args. */
  plan?: PlanStep[]
}

const MARK = "\u001f"

export function encodeToolCardMeta(meta: ToolCardMeta): string {
  const kept: Record<string, unknown> = {}
  if (meta.id) kept.id = meta.id
  if (meta.desc) kept.desc = meta.desc
  if (meta.paths && meta.paths.length > 0) kept.paths = meta.paths
  if (typeof meta.added === "number") kept.added = meta.added
  if (typeof meta.removed === "number") kept.removed = meta.removed
  if (typeof meta.exitCode === "number") kept.exitCode = meta.exitCode
  if (meta.error) kept.error = true
  if (meta.absLines) kept.absLines = true
  if (meta.plan && meta.plan.length > 0) kept.plan = meta.plan
  if (Object.keys(kept).length === 0) return ""
  return `${MARK}${JSON.stringify(kept)}\n`
}

export function decodeToolCardMeta(raw: string): {
  meta: ToolCardMeta
  body: string
} {
  if (!raw.startsWith(MARK)) return { meta: {}, body: raw }
  const newline = raw.indexOf("\n")
  const head = newline === -1 ? raw.slice(1) : raw.slice(1, newline)
  const body = newline === -1 ? "" : raw.slice(newline + 1)
  if (head.startsWith("{")) {
    const parsed = parseObject(head)
    if (parsed) return { meta: readMeta(parsed), body }
  }
  return { meta: head ? { desc: head } : {}, body }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

function readMeta(raw: Record<string, unknown>): ToolCardMeta {
  const meta: ToolCardMeta = {}
  if (typeof raw.id === "string") meta.id = raw.id
  if (typeof raw.desc === "string") meta.desc = raw.desc
  if (Array.isArray(raw.paths)) {
    const paths = raw.paths.filter((p): p is string => typeof p === "string")
    if (paths.length > 0) meta.paths = paths
  }
  if (typeof raw.added === "number") meta.added = raw.added
  if (typeof raw.removed === "number") meta.removed = raw.removed
  if (typeof raw.exitCode === "number") meta.exitCode = raw.exitCode
  if (raw.error === true) meta.error = true
  if (raw.absLines === true) meta.absLines = true
  if (Array.isArray(raw.plan)) {
    const plan = coercePlanSteps(raw.plan)
    if (plan.length > 0) meta.plan = plan
  }
  return meta
}

/** Normalize CLI status strings onto the three plan-step values. */
export function normalizePlanStatus(raw: unknown): PlanStepStatus {
  if (typeof raw !== "string") return "pending"
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (
    s === "completed" ||
    s === "complete" ||
    s === "done" ||
    s === "finished"
  ) {
    return "completed"
  }
  if (
    s === "in_progress" ||
    s === "inprogress" ||
    s === "running" ||
    s === "active" ||
    s === "current"
  ) {
    return "in_progress"
  }
  return "pending"
}

/**
 * Pull plan steps out of Claude TodoWrite / Codex update_plan / todo_list
 * shapes. Unknown junk is skipped rather than failing the whole card.
 */
export function planStepsFromInput(input: unknown): PlanStep[] {
  if (!input || typeof input !== "object") return []
  const o = input as Record<string, unknown>
  if (Array.isArray(o.todos)) return coercePlanSteps(o.todos)
  if (Array.isArray(o.plan)) return coercePlanSteps(o.plan)
  if (Array.isArray(o.items)) return coercePlanSteps(o.items)
  if (Array.isArray(o.steps)) return coercePlanSteps(o.steps)
  return []
}

export function coercePlanSteps(raw: unknown[]): PlanStep[] {
  const out: PlanStep[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const text =
      strField(r.content) ||
      strField(r.step) ||
      strField(r.text) ||
      strField(r.title) ||
      strField(r.activeForm)
    if (!text) continue
    const status =
      r.completed === true
        ? "completed"
        : normalizePlanStatus(r.status)
    out.push({ text, status })
  }
  return out
}

function strField(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/** Tool names that carry a step checklist instead of free-form args. */
export function isPlanToolName(name: string): boolean {
  const lower = name.toLowerCase().replace(/[\s-]+/g, "_")
  return (
    lower === "todowrite" ||
    lower === "todoread" ||
    lower === "update_plan" ||
    lower === "updateplan" ||
    lower === "todo_list" ||
    lower === "todolist" ||
    // Grok Build's checklist tool.
    lower === "todo_write"
  )
}

const ARG_TEXT_KEYS = ["command", "pattern", "query", "url", "prompt"]
const ARG_PATH_KEYS = [
  "target_file",
  "file_path",
  "path",
  "notebook_path",
  "filename",
  "file",
  "directory_path",
]

/**
 * One readable line for a tool call's arguments — the "on what" of a card.
 * Falls back to compact JSON so an unknown tool still says something; only a
 * genuinely empty payload returns "".
 */
export function summarizeToolArgs(args: unknown, limit = 120): string {
  if (typeof args === "string") return clampArg(args, limit)
  if (!args || typeof args !== "object") return ""
  if (Array.isArray(args)) return clampArg(JSON.stringify(args), limit)
  const o = args as Record<string, unknown>
  const plan = planStepsFromInput(o)
  if (plan.length > 0) {
    const active =
      plan.find((step) => step.status === "in_progress") ??
      plan.find((step) => step.status === "pending")
    return clampArg(active?.text ?? `${plan.length} steps`, limit)
  }
  for (const key of [...ARG_TEXT_KEYS, ...ARG_PATH_KEYS, "description"]) {
    const value = o[key]
    if (typeof value === "string" && value.trim()) return clampArg(value, limit)
  }
  const json = JSON.stringify(o) ?? ""
  return json.length > 2 ? clampArg(json, limit) : ""
}

function clampArg(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/

/**
 * MCP tool calls arrive as `mcp__<server>__<tool>`, which reads as noise in a
 * transcript. The server keeps its own chip so the origin is never lost.
 */
export function splitToolName(name: string): {
  label: string
  server: string | null
} {
  const match = MCP_TOOL_NAME.exec(name)
  if (!match) return { label: name, server: null }
  return { label: match[2], server: match[1] }
}

export function fenceFor(body: string): string {
  const runs = body.match(/`{3,}/g)
  const longest = runs
    ? runs.reduce((max, run) => Math.max(max, run.length), 2)
    : 2
  return "`".repeat(Math.max(3, longest + 1))
}
