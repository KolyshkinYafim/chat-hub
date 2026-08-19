import type { PermissionMode } from "@shared/permission"
import type { ModelInfo } from "@shared/settings-types"

export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Light",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
}

export const PERMISSION_SHORT: Record<PermissionMode, string> = {
  yolo: "YOLO",
  acceptEdits: "Edits",
  default: "Ask",
}

export function modelLabel(
  model: string | undefined,
  models: ModelInfo[],
): string {
  if (!model) return "CLI default"
  const known = models.find((m) => m.id === model)
  if (known) return known.label
  return `${model} · not probed`
}

export function composerSummary(opts: {
  model: string | undefined
  models: ModelInfo[]
  effort: Effort
  supportsEffort: boolean
}): string {
  const parts = [modelLabel(opts.model, opts.models)]
  if (opts.supportsEffort) parts.push(EFFORT_LABELS[opts.effort])
  return parts.join(" · ")
}
