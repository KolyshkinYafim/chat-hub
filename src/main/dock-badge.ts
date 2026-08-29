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

/**
 * Every window counts the same shared queue off the same shared storage, so the
 * reports agree once they have all settled; the max is what keeps the badge
 * honest while one window is still catching up, and stops a window that has not
 * finished booting from erasing another's count.
 */
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
    // The app outlives its windows, so the badge has to keep meaning something
    // with none open: the last window's report leaves with it and the count
    // falls back to what the sessions themselves say.
    dropWindow(windowId) {
      if (!reports.delete(windowId)) return
      apply()
    },
  }
}
