import { splitToolName, type PlanStep } from "@shared/tool-card"
import type { ToolCall, TranscriptBlock } from "./tool-runs"

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
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text
}
