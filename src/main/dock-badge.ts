import { app } from "electron"
import type { HubEvent, SessionMeta } from "@shared/types"
import { attentionBadge, needsAction } from "@shared/attention"

export type DockBadge = {
  setRendererCount(windowId: number, count: number): void
  dropWindow(windowId: number): void
}

const INERT: DockBadge = {
  setRendererCount: () => {},
  dropWindow: () => {},
}

export function badgeCount(
  reports: ReadonlyMap<number, number>,
  fallback: number,
): number {
  if (reports.size === 0) return fallback
  return Math.max(...reports.values())
}

export function wireDockBadge(
  bus: { on(listener: (event: HubEvent) => void): () => void },
  listSessions: () => SessionMeta[],
  platform: NodeJS.Platform = process.platform,
): DockBadge {
  if (platform !== "darwin") return INERT

  const reports = new Map<number, number>()
  let fallbackCount = listSessions().filter(needsAction).length
  let shown: string | null = null

  const apply = () => {
    const text = attentionBadge(badgeCount(reports, fallbackCount))
    if (text === shown) return
    shown = text
    app.dock?.setBadge(text)
  }

  bus.on((event) => {
    if (event.type !== "sessions.replaced") return
    fallbackCount = event.sessions.filter(needsAction).length
    apply()
  })
  apply()

  return {
    setRendererCount(windowId, count) {
      reports.set(windowId, count)
      apply()
    },
    dropWindow(windowId) {
      if (!reports.delete(windowId)) return
      apply()
    },
  }
}
