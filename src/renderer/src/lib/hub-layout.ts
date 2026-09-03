import type { HubLayoutCommand } from "@shared/hub-control"
import type { SurfaceKind } from "@shared/surfaces"
import { MAX_PANES, type Pane, type PaneLayout } from "./pane-layout"

export type HubLayoutApplication = {
  layout: PaneLayout
  surfaces: Record<string, SurfaceKind>
}

function paneNumber(id: string): number {
  const match = /^p(\d+)$/.exec(id)
  return match ? Number.parseInt(match[1] as string, 10) : 0
}

export function applyHubLayout(
  current: PaneLayout,
  command: HubLayoutCommand,
): HubLayoutApplication {
  const specs = command.panes.slice(0, MAX_PANES)
  if (specs.length === 0) return { layout: current, surfaces: {} }

  const reused = new Set<string>()
  const drafts = specs.map((spec) => {
    const existing = current.panes.find(
      (pane) => pane.sessionId === spec.sessionId && !reused.has(pane.id),
    )
    if (existing) reused.add(existing.id)
    return { spec, existing }
  })

  let highest = current.panes.reduce(
    (top, pane) => Math.max(top, paneNumber(pane.id)),
    0,
  )
  const panes: Pane[] = drafts.map(({ spec, existing }) => {
    const id = existing ? existing.id : `p${(highest += 1)}`
    return {
      id,
      sessionId: spec.sessionId,
      dockOpen: spec.dockOpen ?? existing?.dockOpen ?? false,
    }
  })

  const focused = command.focusSessionId
    ? panes.find((pane) => pane.sessionId === command.focusSessionId)
    : undefined
  const surfaces: Record<string, SurfaceKind> = {}
  for (const spec of specs) {
    if (spec.surface) surfaces[spec.sessionId] = spec.surface
  }
  return {
    layout: {
      panes,
      focusedPaneId: (focused ?? (panes[0] as Pane)).id,
    },
    surfaces,
  }
}
