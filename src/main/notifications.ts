import { spawn } from "node:child_process"
import { Notification, shell } from "electron"
import type { SessionEvent, SessionMeta, SessionStatus } from "@shared/types"

const MAC_COMPLETION_SOUND = "/System/Library/Sounds/Tink.aiff"

export function playCompletionSound(): void {
  if (process.platform !== "darwin") {
    shell.beep()
    return
  }
  const player = spawn("afplay", [MAC_COMPLETION_SOUND], { stdio: "ignore" })
  player.on("error", () => shell.beep())
  player.unref()
}

export class NotificationService {
  private lastStatus = new Map<string, SessionStatus>()

  constructor(
    private readonly getSession: (id: string) => SessionMeta | undefined,
    private readonly soundEnabled: () => boolean = () => false,
    private readonly playSound: () => void = playCompletionSound,
  ) {}

  handle(event: SessionEvent): void {
    if (event.type === "session.ended" && event.reason === "killed") {
      this.lastStatus.delete(event.id)
      return
    }
    if (event.type !== "session.status") return
    const previous = this.lastStatus.get(event.id)
    this.lastStatus.set(event.id, event.status)
    if (previous === event.status) return
    if (event.status !== "waiting_input" && event.status !== "done") return

    const sound = this.soundEnabled()
    if (sound) this.playSound()
    if (!Notification.isSupported()) return

    const session = this.getSession(event.id)
    const title =
      event.status === "waiting_input"
        ? "Session needs input"
        : "Session finished"
    const body = session
      ? `${session.title} (${session.provider})`
      : event.id

    const n = new Notification({ title, body, silent: sound })
    n.show()
  }
}
