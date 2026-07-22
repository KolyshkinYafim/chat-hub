import { Notification } from "electron"
import type { SessionEvent, SessionMeta } from "@shared/types"

export class NotificationService {
  private lastNotified = new Map<string, string>()

  constructor(private readonly getSession: (id: string) => SessionMeta | undefined) {}

  handle(event: SessionEvent): void {
    if (event.type !== "session.status") return
    if (event.status !== "waiting_input" && event.status !== "done") return
    if (!Notification.isSupported()) return

    const key = `${event.id}:${event.status}`
    if (this.lastNotified.get(event.id) === key) return
    this.lastNotified.set(event.id, key)

    const session = this.getSession(event.id)
    const title =
      event.status === "waiting_input"
        ? "Session needs input"
        : "Session finished"
    const body = session
      ? `${session.title} (${session.provider})`
      : event.id

    const n = new Notification({ title, body, silent: false })
    n.show()
  }
}
