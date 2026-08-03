import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
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
type NewSessionCommand = {
  type: "session.new"
  provider?: string
  cwd?: string
  title?: string
}
type MonitorCommand = FocusCommand | ReplyCommand | NewSessionCommand

/** A command older than this is scenery from a previous run, not a click. */
const STALE_COMMAND_MS = 60_000

/**
 * Tails commands.jsonl written by Session Monitor (open chat / reply).
 */
export class MonitorCommandBridge {
  private readonly filePath: string
  private readonly offsetPath: string
  private offset = 0
  private buffer = ""
  private watcher: FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private reading = false
  private stopped = true

  constructor(
    private readonly manager: SessionManager,
    /** null = only bring the Hub forward, do not change the active session. */
    private readonly onFocus?: (sessionId: string | null) => void,
    filePath = agentDesktopCommandsPath(),
  ) {
    this.filePath = filePath
    this.offsetPath = `${filePath}.offset`
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

    // The Monitor writes the command and *then* launches the Hub, so starting at
    // EOF drops the very click that opened us. Resume where the last run stopped;
    // the ts filter below discards anything that is no longer a live click.
    this.offset = this.loadOffset()
    this.buffer = ""
    this.drain(true)

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

  private drain(catchUp = false): void {
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
        this.flushLines(catchUp)
        this.saveOffset()
      } finally {
        closeSync(fd)
      }
    } catch (err) {
      console.error("[command-bridge] read failed", err)
    } finally {
      this.reading = false
    }
  }

  private flushLines(catchUp: boolean): void {
    let idx = this.buffer.indexOf("\n")
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line) void this.handleLine(line, catchUp)
      idx = this.buffer.indexOf("\n")
    }
  }

  private loadOffset(): number {
    try {
      const saved = JSON.parse(readFileSync(this.offsetPath, "utf8")) as {
        offset?: number
      }
      return typeof saved.offset === "number" && saved.offset >= 0
        ? saved.offset
        : 0
    } catch {
      // No record yet: read from the top and let the ts filter drop old lines.
      return 0
    }
  }

  private saveOffset(): void {
    try {
      writeFileSync(
        this.offsetPath,
        JSON.stringify({ offset: this.offset }),
        "utf8",
      )
    } catch (err) {
      console.error("[command-bridge] offset save failed", err)
    }
  }

  private async handleLine(line: string, catchUp = false): Promise<void> {
    let cmd: MonitorCommand & { ts?: number }
    try {
      cmd = JSON.parse(line) as MonitorCommand & { ts?: number }
    } catch {
      return
    }
    if (!cmd || typeof cmd !== "object" || typeof cmd.type !== "string") return
    // Catch-up only: a click from an hour ago must not focus or spawn anything.
    if (
      catchUp &&
      typeof cmd.ts === "number" &&
      Date.now() - cmd.ts > STALE_COMMAND_MS
    ) {
      return
    }

    if (cmd.type === "session.focus" && typeof cmd.id === "string") {
      const ok = this.manager.setActiveSession(cmd.id)
      if (!ok) {
        console.warn("[command-bridge] focus: unknown session", cmd.id)
      }
      // Surface either way, but never push an id the manager just refused —
      // the renderer would sit on a session that does not exist.
      this.onFocus?.(ok ? cmd.id : null)
      return
    }

    if (
      cmd.type === "session.reply" &&
      typeof cmd.id === "string" &&
      typeof cmd.text === "string"
    ) {
      const ok = this.manager.setActiveSession(cmd.id)
      this.onFocus?.(ok ? cmd.id : null)
      if (!ok) {
        console.warn("[command-bridge] reply: unknown session", cmd.id)
        return
      }
      try {
        await this.manager.sendMessage(cmd.id, cmd.text)
      } catch (err) {
        console.error("[command-bridge] reply failed", err)
      }
      return
    }

    if (cmd.type === "session.new") {
      const provider =
        typeof cmd.provider === "string" && cmd.provider ? cmd.provider : "claude"
      // The island sends no folder; inherit the most recently used one rather
      // than letting the Hub's own process cwd ("/" when packaged) become a project.
      const cwd =
        typeof cmd.cwd === "string" && cmd.cwd.trim()
          ? cmd.cwd
          : this.manager.listSessions()[0]?.cwd
      if (!cwd) {
        console.warn("[command-bridge] session.new: no cwd and no known project")
        this.onFocus?.(null)
        return
      }
      try {
        const session = await this.manager.createSession({
          provider: provider as "claude" | "grok" | "opencode" | "codex" | "mock",
          cwd,
          title: typeof cmd.title === "string" ? cmd.title : undefined,
        })
        this.manager.setActiveSession(session.id)
        this.onFocus?.(session.id)
      } catch (err) {
        console.error("[command-bridge] session.new failed", err)
        // Still surface the app so the user can create manually.
        this.onFocus?.(null)
      }
    }
  }
}
