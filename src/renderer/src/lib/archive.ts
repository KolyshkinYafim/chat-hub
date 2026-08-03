/**
 * Archiving hides a session from the sidebar without deleting its transcript.
 * `SessionMeta` has no `archived` flag yet, so the set lives in localStorage:
 * nothing on disk in main is touched, and an archived session that is still
 * running keeps running.
 */
const ARCHIVE_KEY = "chat-hub.archivedSessions"

export function parseArchived(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === "string"))
  } catch {
    // A hand-edited or half-written value must not take the sidebar down.
    return new Set()
  }
}

export function serializeArchived(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids])
}

/**
 * Drops ids whose session is gone — deletes happen in main and would otherwise
 * leave this set growing for the lifetime of the install.
 */
export function pruneArchived(
  ids: ReadonlySet<string>,
  liveIds: readonly string[],
): Set<string> {
  const live = new Set(liveIds)
  return new Set([...ids].filter((id) => live.has(id)))
}

export function loadArchived(): Set<string> {
  return parseArchived(localStorage.getItem(ARCHIVE_KEY))
}

export function saveArchived(ids: ReadonlySet<string>): void {
  localStorage.setItem(ARCHIVE_KEY, serializeArchived(ids))
}
