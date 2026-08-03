import { appendFile, mkdir, open, stat } from "node:fs/promises"
import { dirname } from "node:path"
import type { SessionEvent } from "@shared/types"
import { agentDesktopEventsPath } from "@shared/bridge-path"
import { withBridgeLock } from "./bridge-lock"

/**
 * Session Monitor is the primary trimmer (2 MB → last 1500 lines, under flock —
 * see session-monitor/docs/bridge.md). The Hub's cap sits far above that so the
 * two never trim the same file: this only fires when the Monitor is not running
 * and nothing else would ever reclaim the space.
 */
const MAX_BRIDGE_BYTES = 8_000_000
const KEEP_LINES = 1_500

export type BridgeLimits = { maxBytes?: number; keepLines?: number }

/**
 * Session Monitor bridge — append-only JSONL of SessionEvent.
 * Path: agentDesktopEventsPath() (see docs/bridge.md).
 */
export class SessionMonitorBridge {
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly maxBytes: number
  private readonly keepLines: number

  constructor(
    private readonly filePath: string,
    limits: BridgeLimits = {},
  ) {
    this.maxBytes = limits.maxBytes ?? MAX_BRIDGE_BYTES
    this.keepLines = limits.keepLines ?? KEEP_LINES
  }

  get path(): string {
    return this.filePath
  }

  publish(event: SessionEvent): void {
    const line = `${JSON.stringify({ ...event, ts: Date.now() })}\n`
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        // A single O_APPEND write is atomic against other appenders, so the
        // append itself needs no lock — only a trim can lose it, and the
        // trimmers on both sides take the lock before rewriting.
        await appendFile(this.filePath, line, "utf8")
        await this.trimIfHuge()
      })
      .catch((err) => {
        console.error("[bridge] write failed", err)
      })
  }

  /** Await pending appends (tests; also gives quit a settled file). */
  async flush(): Promise<void> {
    await this.writeQueue
  }

  /**
   * Trim in place — same inode, so the Monitor's tail and any hook holding an
   * O_APPEND descriptor keep working, exactly like the Swift trimmer does.
   *
   * Read-modify-write is the one operation here that can destroy someone else's
   * append, so it only runs while the shared lock is held; without the lock we
   * leave the file oversized and try again on the next publish.
   */
  private async trimIfHuge(): Promise<void> {
    const size = (await stat(this.filePath)).size
    if (size <= this.maxBytes) return

    await withBridgeLock(this.filePath, async (locked) => {
      if (!locked) return
      const handle = await open(this.filePath, "r+")
      try {
        const raw = await handle.readFile("utf8")
        const lines = raw.split("\n").filter((l) => l.length > 0)
        if (lines.length <= this.keepLines) return
        const tail = `${lines.slice(-this.keepLines).join("\n")}\n`
        await handle.truncate(0)
        await handle.write(tail, 0)
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
  }

  static defaultPath(): string {
    return agentDesktopEventsPath()
  }
}
