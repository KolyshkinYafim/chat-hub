import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs"
import { dirname } from "node:path"
import { agentDesktopCommandsPath } from "@shared/bridge-path"
import type { SessionManager } from "./session-manager"

type FocusCommand = { type: "session.focus"; id: string }
type ReplyCommand = {
  type: "session.reply"
  id: string
  text: string
  requestId?: string
}
type MonitorCommand = FocusCommand | ReplyCommand

/**
 * Tails commands.jsonl written by Session Monitor (open chat / reply).
 */
export class MonitorCommandBridge {
  private readonly filePath: string
  private offset = 0
  private buffer = ""
  private watcher: FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private reading = false
  private stopped = true

  constructor(
    private readonly manager: SessionManager,
    private readonly onFocus?: (sessionId: string) => void,
    filePath = agentDesktopCommandsPath(),
  ) {
    this.filePath = filePath
  }

  get path(): string {
    return this.filePath
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      if (!existsSync(this.filePath)) writeFileSync(this.filePath, "", "utf8")
    } catch (err) {
      console.error("[command-bridge] ensure failed", err)
      this.stopped = true
      return
    }

    // Do not replay history — only new commands after start.
    try {
      this.offset = existsSync(this.filePath) ? statSync(this.filePath).size : 0
    } catch {
      this.offset = 0
    }
    this.buffer = ""

    try {
      this.watcher = watch(this.filePath, () => this.drain())
      this.watcher.on("error", (err) => {
        console.error("[command-bridge] watch error", err)
      })
    } catch (err) {
      console.error("[command-bridge] watch failed", err)
    }

    this.pollTimer = setInterval(() => this.drain(), 500)
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.watcher?.close()
    this.watcher = null
  }

  private drain(): void {
    if (this.stopped || this.reading) return
    this.reading = true
    try {
      if (!existsSync(this.filePath)) return
      const size = statSync(this.filePath).size
      if (size < this.offset) {
        this.offset = 0
        this.buffer = ""
      }
      if (size === this.offset) return

      const fd = openSync(this.filePath, "r")
      try {
        const length = size - this.offset
        const buf = Buffer.alloc(length)
        readSync(fd, buf, 0, length, this.offset)
        this.offset = size
        this.buffer += buf.toString("utf8")
        this.flushLines()
      } finally {
        closeSync(fd)
      }
    } catch (err) {
      console.error("[command-bridge] read failed", err)
    } finally {
      this.reading = false
    }
  }

  private flushLines(): void {
    let idx = this.buffer.indexOf("\n")
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line) void this.handleLine(line)
      idx = this.buffer.indexOf("\n")
    }
  }

  private async handleLine(line: string): Promise<void> {
    let cmd: MonitorCommand
    try {
      cmd = JSON.parse(line) as MonitorCommand
    } catch {
      return
    }
    if (!cmd || typeof cmd !== "object" || typeof cmd.type !== "string") return

    if (cmd.type === "session.focus" && typeof cmd.id === "string") {
      this.manager.setActiveSession(cmd.id)
      this.onFocus?.(cmd.id)
      return
    }

    if (
      cmd.type === "session.reply" &&
      typeof cmd.id === "string" &&
      typeof cmd.text === "string"
    ) {
      this.manager.setActiveSession(cmd.id)
      this.onFocus?.(cmd.id)
      try {
        await this.manager.sendMessage(cmd.id, cmd.text)
      } catch (err) {
        console.error("[command-bridge] reply failed", err)
      }
    }
  }
}
