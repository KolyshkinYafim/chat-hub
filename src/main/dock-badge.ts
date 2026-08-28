import { app } from "electron"
import type { HubEvent, SessionMeta } from "@shared/types"
import { attentionBadge, needsAction } from "@shared/attention"

export type DockBadge = {
  setRendererCount(count: number): void
  clearRendererCount(): void
}

const INERT: DockBadge = {
  setRendererCount: () => {},
  clearRendererCount: () => {},
}

export function wireDockBadge(
  bus: { on(listener: (event: HubEvent) => void): () => void },
  listSessions: () => SessionMeta[],
  platform: NodeJS.Platform = process.platform,
): DockBadge {
  if (platform !== "darwin") return INERT

  let rendererCount: number | null = null
  let fallbackCount = listSessions().filter(needsAction).length
  let shown: string | null = null

  const apply = () => {
    const text = attentionBadge(rendererCount ?? fallbackCount)
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
    setRendererCount(count) {
      rendererCount = count
      apply()
    },
    clearRendererCount() {
      rendererCount = null
      apply()
    },
  }
}
