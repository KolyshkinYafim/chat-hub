import { app } from "electron"
import type { HubEvent, SessionMeta } from "@shared/types"
import { attentionBadge } from "@shared/attention"

const BADGE_EVENTS = new Set<HubEvent["type"]>([
  "session.status",
  "session.upsert",
  "session.ended",
  "sessions.replaced",
])

export function wireDockBadge(
  bus: { on(listener: (event: HubEvent) => void): () => void },
  listSessions: () => SessionMeta[],
): void {
  if (process.platform !== "darwin") return
  let shown: string | null = null
  const apply = () => {
    const text = attentionBadge(listSessions())
    if (text === shown) return
    shown = text
    app.dock?.setBadge(text)
  }
  bus.on((event) => {
    if (BADGE_EVENTS.has(event.type)) apply()
  })
  apply()
}
