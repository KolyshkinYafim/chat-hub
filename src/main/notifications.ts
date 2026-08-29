import { Notification } from "electron"
import type { SessionEvent, SessionMeta, SessionStatus } from "@shared/types"

type Stretch = { last: SessionStatus; waiting: boolean }

export class NotificationService {
  private stretches = new Map<string, Stretch>()

  constructor(
    private readonly getSession: (id: string) => SessionMeta | undefined,
    private readonly soundEnabled: () => boolean = () => false,
    private readonly onActivate: (sessionId: string) => void = () => {},
  ) {}

  handle(event: SessionEvent): void {
    if (event.type === "session.ended" && event.reason === "killed") {
      this.stretches.delete(event.id)
      return
    }
    if (event.type !== "session.status") return
    const prev = this.stretches.get(event.id)
    const fresh =
      (event.status === "waiting_input" && prev?.waiting !== true) ||
      (event.status === "done" && prev?.last !== "done")
    this.stretches.set(event.id, {
      last: event.status,
      waiting:
        event.status === "waiting_input" ||
        (event.status === "running" && prev?.waiting === true),
    })
    if (!fresh || !Notification.isSupported()) return

    const session = this.getSession(event.id)
    const title =
      event.status === "waiting_input"
        ? "Session needs input"
        : "Session finished"
    const body = session
      ? `${session.title} (${session.provider})`
      : event.id

    const n = new Notification({ title, body, silent: !this.soundEnabled() })
    n.on("click", () => this.onActivate(event.id))
    n.show()
  }
}
