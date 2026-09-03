import type { ProviderRateLimits } from "@shared/types"

export type AllowanceWindow = { used: number; mins?: number; resets?: number }

export function allowanceWindows(limits: ProviderRateLimits): AllowanceWindow[] {
  const out: AllowanceWindow[] = []
  if (typeof limits.primaryUsed === "number") {
    out.push({
      used: limits.primaryUsed,
      mins: limits.primaryWindowMins,
      resets: limits.primaryResetsAt,
    })
  }
  if (typeof limits.secondaryUsed === "number") {
    out.push({
      used: limits.secondaryUsed,
      mins: limits.secondaryWindowMins,
      resets: limits.secondaryResetsAt,
    })
  }
  return out
}

export function windowLabel(mins: number | undefined): string {
  if (mins === undefined) return "window"
  if (mins % 10080 === 0) return `${mins / 10080}w`
  if (mins % 1440 === 0) return `${mins / 1440}d`
  if (mins % 60 === 0) return `${mins / 60}h`
  return `${mins}m`
}

export function allowanceTitle(w: AllowanceWindow): string {
  const spent = `${usedPercent(w.used)}% of the ${windowLabel(w.mins)} allowance used`
  if (w.resets === undefined) return spent
  return `${spent} · resets ${new Date(w.resets).toLocaleString("en-US")}`
}

export function reachedLabel(reached: string): string {
  return reached.replace(/_/g, " ")
}

function usedPercent(used: number): number {
  if (!Number.isFinite(used)) return 0
  return Math.max(0, Math.round(used * 100))
}

function chipWindowLabel(mins: number | undefined): string | null {
  if (mins === undefined) return null
  if (mins % 10080 === 0) return mins === 10080 ? "wk" : `${mins / 10080}w`
  if (mins % 1440 === 0) return mins === 1440 ? "d" : `${mins / 1440}d`
  if (mins % 60 === 0) return `${mins / 60}h`
  return `${mins}m`
}

export function formatQuotaChip(
  limits: ProviderRateLimits | null | undefined,
): string | null {
  if (!limits) return null
  const windows = allowanceWindows(limits)
  if (windows.length === 0) return limits.reached ? "limit reached" : null
  return windows
    .map((w) => {
      const label = chipWindowLabel(w.mins)
      const pct = `${usedPercent(w.used)}%`
      return label ? `${pct} ${label}` : pct
    })
    .join(" · ")
}

export function quotaChipTitle(
  limits: ProviderRateLimits | null | undefined,
): string | null {
  if (!limits) return null
  const parts = allowanceWindows(limits).map(allowanceTitle)
  if (limits.reached) parts.unshift(reachedLabel(limits.reached))
  return parts.length > 0 ? parts.join("\n") : null
}
