import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { SessionEvent } from "@shared/types"

/**
 * Session Monitor bridge — append-only JSONL of SessionEvent.
 *
 * Path (documented for Session Monitor consumers):
 *   <userData>/bridge/session-events.jsonl
 *
 * Each line is one JSON SessionEvent object.
 * Session Monitor can tail this file (or a future Unix socket).
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

  static defaultPath(userData: string): string {
    return join(userData, "bridge", "session-events.jsonl")
  }
}
