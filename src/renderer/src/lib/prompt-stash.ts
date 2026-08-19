export type StashEntry = {
  id: string
  text: string
  sessionId: string
  at: number
}

export const STASH_LIMIT = 20

const STASH_KEY = "chat-hub.promptStash"

function isEntry(value: unknown): value is StashEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === "string" &&
    typeof entry.text === "string" &&
    typeof entry.sessionId === "string" &&
    typeof entry.at === "number"
  )
}

export function loadStash(): StashEntry[] {
  const raw = localStorage.getItem(STASH_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).slice(0, STASH_LIMIT)
  } catch {
    return []
  }
}

function save(entries: StashEntry[]): StashEntry[] {
  localStorage.setItem(STASH_KEY, JSON.stringify(entries))
  return entries
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Returns the updated stash, newest first; blank drafts are rejected unchanged. */
export function pushStash(text: string, sessionId: string): StashEntry[] {
  const trimmed = text.trim()
  if (!trimmed) return loadStash()
  const entry: StashEntry = {
    id: newId(),
    text: trimmed,
    sessionId,
    at: Date.now(),
  }
  return save([entry, ...loadStash()].slice(0, STASH_LIMIT))
}

export function removeStash(id: string): StashEntry[] {
  return save(loadStash().filter((entry) => entry.id !== id))
}
