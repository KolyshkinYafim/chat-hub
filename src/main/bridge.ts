import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { SessionEvent } from "@shared/types"
import { agentDesktopEventsPath } from "@shared/bridge-path"

/**
 * Session Monitor bridge — append-only JSONL of SessionEvent.
 * Path: agentDesktopEventsPath() (see docs/bridge.md).
 */
export class SessionMonitorBridge {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath
  }

  publish(event: SessionEvent): void {
    const line = `${JSON.stringify({ ...event, ts: Date.now() })}\n`
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        await appendFile(this.filePath, line, "utf8")
      })
      .catch((err) => {
        console.error("[bridge] write failed", err)
      })
  }

  static defaultPath(): string {
    return agentDesktopEventsPath()
  }
}
