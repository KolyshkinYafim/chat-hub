import type { HookRun } from "@shared/hooks"

/** One terminal banner line: ◆ session_start   [hooks: 3] */
export type HookBanner = {
  key: string
  trigger: string
  count: number
  /** Tooltip: hookName → status */
  detail: string
}

/**
 * Collapse consecutive hook.ran events that share a trigger into one banner
 * row. A new banner starts when the trigger changes or a gap > 2s appears.
 */
export function groupHookBanners(runs: HookRun[]): HookBanner[] {
  if (runs.length === 0) return []
  const banners: HookBanner[] = []
  let cur: {
    trigger: string
    runs: HookRun[]
    firstAt: number
  } | null = null

  const flush = () => {
    if (!cur || cur.runs.length === 0) return
    const names = cur.runs
      .map((r) => `${r.hookName}:${r.status}`)
      .join(", ")
    banners.push({
      key: `${cur.trigger}-${cur.firstAt}-${cur.runs[0]!.id}`,
      trigger: cur.trigger,
      count: cur.runs.length,
      detail: names,
    })
    cur = null
  }

  for (const run of runs) {
    if (
      !cur ||
      cur.trigger !== run.trigger ||
      run.startedAt - cur.runs[cur.runs.length - 1]!.startedAt > 2_000
    ) {
      flush()
      cur = { trigger: run.trigger, runs: [run], firstAt: run.startedAt }
    } else {
      cur.runs.push(run)
    }
  }
  flush()
  return banners
}
