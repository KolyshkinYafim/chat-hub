const ARCHIVE_KEY = "chat-hub.archivedSessions"

export function parseArchived(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === "string")
  } catch {
    return []
  }
}

/**
 * Legacy renderer-only archive set. `SessionMeta.archived` in main is the
 * truth now; this read exists only to migrate the old localStorage ids once.
 */
export function readArchivedForMigration(): string[] {
  return parseArchived(localStorage.getItem(ARCHIVE_KEY))
}

export function clearMigratedArchive(): void {
  localStorage.removeItem(ARCHIVE_KEY)
}
