import { oneLine } from "@shared/text"
import { splitToolName, summarizeToolArgs, type PlanStep } from "@shared/tool-card"
import type { AgentTurnItem } from "@shared/types"
import { unwrapShell, type ToolCall, type TranscriptBlock } from "./tool-runs"

export type LiveStep = {
  key: string
  kind: "tool" | "thinking" | "writing" | "starting"
  label: string
  detail: string | null
  server: string | null
}

export type PlanProgress = {
  done: number
  total: number
  active: string | null
}

const DETAIL_MAX = 80

/**
 * The one step worth showing live for a provider that streams structured items
 * rather than tool fences in the prose. Null once nothing is open.
 */
export function itemStep(items: AgentTurnItem[] | undefined): LiveStep | null {
  if (!items?.length) return null
  const open = items.filter(
    (item) => item.status === "running" || item.status === "pending",
  )
  const actions = open.filter((item) => item.kind !== "reasoning")
  const action =
    [...actions].reverse().find((item) => item.status === "running") ??
    actions.find((item) => item.status === "pending")
  if (action) {
    const { label, detail, server } = describeItem(action)
    return {
      key: `item:${action.id}`,
      kind: "tool",
      label,
      detail: detail ? clampDetail(detail) : null,
      server,
    }
  }
  if (open.length === 0) return null
  return {
    key: "item:thinking",
    kind: "thinking",
    label: "Thinking",
    detail: null,
    server: null,
  }
}

/** Checklist progress carried by a provider's own plan item. */
export function itemPlanProgress(
  items: AgentTurnItem[] | undefined,
): PlanProgress | null {
  let steps: { text: string; status: string }[] | null = null
  for (const item of items ?? []) {
    if (item.kind === "plan" && item.steps && item.steps.length > 0) {
      steps = item.steps
    }
  }
  if (!steps) return null
  return {
    done: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
    active: steps.find((step) => step.status === "running")?.text ?? null,
  }
}

/** What a turn item is doing, split into "which tool" and "on what". */
export function describeItem(item: AgentTurnItem): {
  label: string
  detail: string
  server: string | null
} {
  const plain = (label: string, detail: string) => ({ label, detail, server: null })
  switch (item.kind) {
    case "command":
      return plain("Shell", unwrapShell(item.command.split("\n")[0] ?? ""))
    case "tool": {
      const { label, server } = splitToolName(item.name)
      return { label, detail: summarizeToolArgs(item.arguments), server }
    }
    case "file_change": {
      const paths = item.changes.map((change) => change.path)
      if (paths.length === 1) return plain("Edit", paths[0]!)
      return plain("Edit", paths.length ? `${paths.length} files` : "code diff")
    }
    case "plan": {
      const active =
        item.steps?.find((step) => step.status === "running") ??
        item.steps?.find((step) => step.status === "pending")
      return plain("Plan", active?.text || item.text)
    }
    case "subagent": {
      const open = item.steps?.find((step) => step.status === "running")
      const detail =
        [open?.label, open?.detail].filter(Boolean).join(" · ") ||
        item.description ||
        `${item.steps?.length ?? 0} steps`
      return plain(`${item.name} agent`, detail)
    }
    case "web_search":
      return plain("Search", item.query)
    case "image":
      return plain("Image", item.path)
    case "review":
      return plain("Review", item.text)
    case "compaction":
      return plain("Compacting context", compactionDetail(item))
    case "reasoning":
      return plain("Reasoning", "")
    case "notice":
      return plain(
        item.level === "warning" ? "Warning" : "Note",
        item.detail ? `${item.title} · ${item.detail}` : item.title,
      )
    case "error":
      return plain("Error", item.message)
    // A transcript written by a newer build can carry a kind this one has
    // never heard of; a row that says nothing beats a renderer that throws.
    default:
      return plain("Step", "")
  }
}

function compactionDetail(item: AgentTurnItem & { kind: "compaction" }): string {
  if (item.preTokens === undefined) return ""
  const to = item.postTokens === undefined ? "" : ` → ${formatTokens(item.postTokens)}`
  return `${formatTokens(item.preTokens)}${to} tokens`
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 100) / 10}k` : String(count)
}

export function currentStep(blocks: TranscriptBlock[]): LiveStep {
  const open = lastOpenCall(blocks)
  if (open) {
    const { label, server } = splitToolName(open.name)
    return {
      key: `tool:${open.key}`,
      kind: "tool",
      label,
      detail: callDetail(open),
      server,
    }
  }

  const last = blocks[blocks.length - 1]
  if (!last) {
    return { key: "starting", kind: "starting", label: "Starting", detail: null, server: null }
  }
  const at = blocks.length - 1
  if (last.kind === "reasoning" || last.kind === "tools" || last.kind === "plan") {
    return { key: `thinking:${at}`, kind: "thinking", label: "Thinking", detail: null, server: null }
  }
  return { key: `writing:${at}`, kind: "writing", label: "Writing", detail: null, server: null }
}

export function planProgress(blocks: TranscriptBlock[]): PlanProgress | null {
  let steps: PlanStep[] | null = null
  for (const block of blocks) {
    if (block.kind === "plan" && block.meta.plan && block.meta.plan.length > 0) {
      steps = block.meta.plan
    }
  }
  if (!steps) return null
  return {
    done: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
    active: steps.find((step) => step.status === "in_progress")?.text ?? null,
  }
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  if (totalMinutes > 0) return `${totalMinutes}m ${pad(seconds)}s`
  return `${seconds}s`
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function lastOpenCall(blocks: TranscriptBlock[]): ToolCall | null {
  let open: ToolCall | null = null
  for (const block of blocks) {
    if (block.kind !== "tools") continue
    for (const call of block.calls) {
      if (call.result === null) open = call
    }
  }
  return open
}

function callDetail(call: ToolCall): string | null {
  const text = (call.meta.desc ?? call.title).replace(/^\$ /, "").trim()
  if (!text) return null
  return clampDetail(text)
}

function clampDetail(text: string): string {
  return oneLine(text, DETAIL_MAX)
}
