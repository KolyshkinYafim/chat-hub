import { access, appendFile, mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import type { ChatMessage } from "@shared/types"
import {
  ARCHIVE_JUMP_LIMIT,
  ARCHIVE_SEARCH_SCAN_LIMIT,
  excerpt,
  MIN_TRANSCRIPT_QUERY,
  type TranscriptHit,
} from "@shared/search"
import { dropLegacyMessageFields } from "./legacy-message"

export type ArchivedPage = {
  messages: ChatMessage[]
  /** True when more archive lines exist older than this page. */
  hasMore: boolean
}

/** A page fetched to land on one message rather than to continue scrolling. */
export type ArchivedContext = ArchivedPage & {
  /** False when the target sits further back than one jump may load. */
  reachedTarget: boolean
}

/** What one session's archive contributed to a search. */
export type ArchiveSessionHit = {
  hit: TranscriptHit | null
  /** True when older archived messages were left unscanned. */
  truncated: boolean
}

/** Archived turns kept above the hit, so it lands with something to read. */
const JUMP_CONTEXT = 10

export function sessionDirUnder(rootDir: string, sessionId: string): string {
  const base = resolve(rootDir)
  const dir = resolve(join(base, sessionId))
  if (dir === base || !dir.startsWith(base + sep)) {
    throw new Error(`Invalid session id: ${sessionId}`)
  }
  return dir
}

/**
 * A query of only these characters reaches disk byte for byte: nothing in the
 * class is escaped by `JSON.stringify` and non-ASCII is left alone, so a miss
 * against the raw file is a real miss and the archive is skipped unparsed.
 * Whitespace, quotes and backslashes are excluded on purpose — those are where
 * the stored bytes and the message text differ, so they take the full parse.
 */
const VERBATIM_IN_JSON = /^[^\s"\\]+$/

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
    return sessionDirUnder(this.rootDir, sessionId)
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

    const end = endOf(all, beforeMessageId)
    if (end <= 0) return { messages: [], hasMore: false }
    const start = Math.max(0, end - cap)
    return {
      messages: all.slice(start, end),
      hasMore: start > 0,
    }
  }

  /**
   * One contiguous page reaching back far enough to include `targetMessageId`,
   * so a search hit found on disk can be scrolled to. The page always ends where
   * the caller's transcript already begins — a gap in the middle of a chat log
   * is worse than a page that admits it could not reach far enough.
   */
  async loadThrough(
    sessionId: string,
    beforeMessageId: string | null,
    targetMessageId: string,
    limit: number = ARCHIVE_JUMP_LIMIT,
  ): Promise<ArchivedContext> {
    const cap = Math.max(1, Math.min(limit, ARCHIVE_JUMP_LIMIT))
    const all = await this.readAll(sessionId)
    if (all.length === 0) {
      return { messages: [], hasMore: false, reachedTarget: false }
    }

    const end = endOf(all, beforeMessageId)
    const target = all.findIndex((m) => m.id === targetMessageId)
    if (target === -1) {
      return { messages: [], hasMore: end > 0, reachedTarget: false }
    }
    // Already inside what the caller holds: nothing to fetch, nothing to say.
    if (target >= end) {
      return { messages: [], hasMore: end > 0, reachedTarget: true }
    }

    let start = Math.max(0, target - JUMP_CONTEXT)
    if (end - start > cap) start = end - cap
    return {
      messages: all.slice(start, end),
      hasMore: start > 0,
      reachedTarget: start <= target,
    }
  }

  /**
   * Search the archived messages strictly older than `beforeMessageId` — the
   * exact half of the transcript the caller has not loaded, so its own scan and
   * this one never count the same message twice. Scans newest first, because
   * the reported hit is the latest match and the budget should be spent near
   * the live window rather than at the beginning of time.
   */
  async search(
    sessionId: string,
    query: string,
    beforeMessageId: string | null,
    scanLimit: number = ARCHIVE_SEARCH_SCAN_LIMIT,
  ): Promise<ArchiveSessionHit> {
    const q = query.trim()
    if (q.length < MIN_TRANSCRIPT_QUERY) return { hit: null, truncated: false }

    const raw = await this.readRaw(sessionId)
    if (!raw) return { hit: null, truncated: false }
    if (VERBATIM_IN_JSON.test(q) && !raw.toLowerCase().includes(q.toLowerCase())) {
      return { hit: null, truncated: false }
    }

    const all = parseArchive(raw)
    const end = endOf(all, beforeMessageId)
    if (end <= 0) return { hit: null, truncated: false }

    const start = Math.max(0, end - Math.max(1, scanLimit))
    let latest: TranscriptHit | null = null
    let hits = 0
    for (let i = end - 1; i >= start; i--) {
      const message = all[i]
      if (!message) continue
      const found = excerpt(message.content, q)
      if (!found) continue
      hits += 1
      latest ??= { sessionId, messageId: message.id, ...found, hits: 0 }
    }
    return {
      hit: latest ? { ...latest, hits } : null,
      truncated: start > 0,
    }
  }

  private async readRaw(sessionId: string): Promise<string> {
    try {
      return await readFile(this.fileFor(sessionId), "utf8")
    } catch {
      return ""
    }
  }

  private async readAll(sessionId: string): Promise<ChatMessage[]> {
    return parseArchive(await this.readRaw(sessionId))
  }
}

/** Where the caller's own transcript starts, as an index into the archive. */
function endOf(all: readonly ChatMessage[], beforeMessageId: string | null): number {
  if (!beforeMessageId) return all.length
  const idx = all.findIndex((m) => m.id === beforeMessageId)
  // Id lives only in memory (first live message): the whole archive is older.
  return idx === -1 ? all.length : idx
}

function parseArchive(raw: string): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const msg = JSON.parse(trimmed) as ChatMessage
      if (msg && typeof msg.id === "string" && typeof msg.sessionId === "string") {
        out.push(dropLegacyMessageFields({ ...msg, streaming: false }))
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return out
}

function stripStreaming(m: ChatMessage): ChatMessage {
  const { streaming: _s, ...rest } = m
  void _s
  return rest
}
