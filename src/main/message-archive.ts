import { access, appendFile, mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import type { ChatMessage } from "@shared/types"

export type ArchivedPage = {
  messages: ChatMessage[]
  /** True when more archive lines exist older than this page. */
  hasMore: boolean
}

/**
 * Append-only overflow store for session transcripts.
 * Layout: `<dataDir>/sessions/<sessionId>/archive.jsonl` — one JSON ChatMessage
 * per line, oldest first (each overflow batch is appended in chronological order).
 */
export class MessageArchive {
  constructor(private readonly rootDir: string) {}

  /** Sibling of state.json: `…/data/sessions`. */
  static fromStatePath(statePath: string): MessageArchive {
    return new MessageArchive(join(dirname(statePath), "sessions"))
  }

  /** Session ids come from the app, but this path is what `remove` deletes. */
  dirFor(sessionId: string): string {
    const base = resolve(this.rootDir)
    const dir = resolve(join(base, sessionId))
    if (dir === base || !dir.startsWith(base + sep)) {
      throw new Error(`Invalid session id: ${sessionId}`)
    }
    return dir
  }

  fileFor(sessionId: string): string {
    return join(this.dirFor(sessionId), "archive.jsonl")
  }

  async hasArchive(sessionId: string): Promise<boolean> {
    try {
      await access(this.fileFor(sessionId))
      return true
    } catch {
      return false
    }
  }

  /** Deleting a session must not leave its transcript readable on disk. */
  async remove(sessionId: string): Promise<void> {
    await rm(this.dirFor(sessionId), { recursive: true, force: true })
  }

  /** Append messages (already oldest→newest). Does nothing for empty input. */
  async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return
    const file = this.fileFor(sessionId)
    await mkdir(dirname(file), { recursive: true })
    const body = messages.map((m) => JSON.stringify(stripStreaming(m))).join("\n") + "\n"
    await appendFile(file, body, "utf8")
  }

  /**
   * Read up to `limit` messages strictly older than `beforeMessageId`.
   * When `beforeMessageId` is null, returns the newest archived chunk
   * (the ones closest to the in-memory window).
   */
  async loadBefore(
    sessionId: string,
    beforeMessageId: string | null,
    limit: number,
  ): Promise<ArchivedPage> {
    const cap = Math.max(1, Math.min(limit, 200))
    const all = await this.readAll(sessionId)
    if (all.length === 0) return { messages: [], hasMore: false }

    let end = all.length
    if (beforeMessageId) {
      const idx = all.findIndex((m) => m.id === beforeMessageId)
      if (idx === -1) {
        // Id lives only in memory (first live message): take the archive tail.
        end = all.length
      } else {
        end = idx
      }
    }

    if (end <= 0) return { messages: [], hasMore: false }
    const start = Math.max(0, end - cap)
    return {
      messages: all.slice(start, end),
      hasMore: start > 0,
    }
  }

  private async readAll(sessionId: string): Promise<ChatMessage[]> {
    let raw: string
    try {
      raw = await readFile(this.fileFor(sessionId), "utf8")
    } catch {
      return []
    }
    const out: ChatMessage[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed) as ChatMessage
        if (msg && typeof msg.id === "string" && typeof msg.sessionId === "string") {
          out.push({ ...msg, streaming: false })
        }
      } catch {
        /* skip corrupt line */
      }
    }
    return out
  }
}

function stripStreaming(m: ChatMessage): ChatMessage {
  const { streaming: _s, ...rest } = m
  void _s
  return rest
}
