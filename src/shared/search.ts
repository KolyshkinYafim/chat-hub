import type { ChatMessage } from "@shared/types"

/** The first hit in a session's transcript, ready to render as a sidebar row. */
export type TranscriptHit = {
  sessionId: string
  messageId: string
  /** Whitespace-collapsed excerpt around the match, elided on both sides. */
  snippet: string
  /** Offset of the match inside `snippet`, so the row can mark it. */
  matchStart: number
  matchLength: number
  /** Messages in this session that matched, not occurrences. */
  hits: number
}

/**
 * What main found in the parts of a transcript the renderer never loaded.
 * `truncated` means at least one archive was deeper than the scan budget, so
 * the counts below it are a floor rather than a total.
 */
export type ArchiveSearchResult = {
  hits: TranscriptHit[]
  truncated: boolean
}

/**
 * One letter matches every transcript ever written, so the full-text pass only
 * starts once the query says something. Title/project filtering is unaffected.
 */
export const MIN_TRANSCRIPT_QUERY = 2

/** Newest archived messages main scans per session for one search. */
export const ARCHIVE_SEARCH_SCAN_LIMIT = 2000

/** Ceiling on a single jump-to-hit load, so one click cannot hang the list. */
export const ARCHIVE_JUMP_LIMIT = 600

const PAD = 34
const SNIPPET_MAX = 110

export function excerpt(
  text: string,
  query: string,
): { snippet: string; matchStart: number; matchLength: number } | null {
  // Collapsed first, then searched: the offsets we hand back have to index the
  // string the row actually renders, not the original with its newlines.
  const flat = text.replace(/\s+/g, " ").trim()
  const at = flat.toLowerCase().indexOf(query.toLowerCase())
  if (at === -1) return null

  const start = Math.max(0, at - PAD)
  const end = Math.min(flat.length, Math.max(start + SNIPPET_MAX, at + query.length))
  const head = start > 0 ? "…" : ""
  const tail = end < flat.length ? "…" : ""
  return {
    snippet: `${head}${flat.slice(start, end)}${tail}`,
    matchStart: at - start + head.length,
    matchLength: query.length,
  }
}

/**
 * Full-text search over every loaded transcript, keyed by session id. The hit
 * reported is the *latest* matching message: in a chat log the useful landing
 * point is where the topic was last discussed, not where it started.
 */
export function searchTranscripts(
  query: string,
  messagesBySession: Record<string, ChatMessage[]>,
): Map<string, TranscriptHit> {
  const out = new Map<string, TranscriptHit>()
  const q = query.trim()
  if (q.length < MIN_TRANSCRIPT_QUERY) return out

  for (const [sessionId, list] of Object.entries(messagesBySession)) {
    let latest: TranscriptHit | null = null
    let hits = 0
    for (const m of list as ChatMessage[]) {
      const found = excerpt(m.content, q)
      if (!found) continue
      hits += 1
      latest = { sessionId, messageId: m.id, ...found, hits: 0 }
    }
    if (latest) out.set(sessionId, { ...latest, hits })
  }
  return out
}

/**
 * Fold main's archive hits into the loaded-transcript hits. The two scans cover
 * disjoint halves of a session (main is told where the loaded half starts), so
 * the counts add up; the loaded hit stays the landing point because it is the
 * newer of the two.
 */
export function mergeTranscriptHits(
  loaded: Map<string, TranscriptHit>,
  archived: readonly TranscriptHit[],
): Map<string, TranscriptHit> {
  if (archived.length === 0) return loaded
  const out = new Map(loaded)
  for (const hit of archived) {
    const known = out.get(hit.sessionId)
    if (!known) {
      out.set(hit.sessionId, hit)
      continue
    }
    out.set(hit.sessionId, { ...known, hits: known.hits + hit.hits })
  }
  return out
}
