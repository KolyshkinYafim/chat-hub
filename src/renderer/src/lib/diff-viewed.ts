export { hashDiff } from "@shared/diff-hash"

export type ViewedMap = Record<string, string>

export function withViewed(
  map: ViewedMap,
  key: string,
  hash: string,
): ViewedMap {
  if (map[key] === hash) return map
  return { ...map, [key]: hash }
}

export function withoutViewed(map: ViewedMap, key: string): ViewedMap {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

export function isViewed(map: ViewedMap, key: string, hash: string): boolean {
  return map[key] === hash
}

export function reconcileViewed(
  map: ViewedMap,
  currentHashes: ViewedMap,
): ViewedMap {
  const kept = Object.entries(map).filter(
    ([key, hash]) => currentHashes[key] === hash,
  )
  if (kept.length === Object.keys(map).length) return map
  return Object.fromEntries(kept)
}

const STORE_KEY = "chat-hub.diffViewed"

function readStore(): Record<string, ViewedMap> {
  const raw = localStorage.getItem(STORE_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    const out: Record<string, ViewedMap> = {}
    for (const [sessionId, maps] of Object.entries(parsed)) {
      if (typeof maps !== "object" || maps === null || Array.isArray(maps)) {
        continue
      }
      out[sessionId] = Object.fromEntries(
        Object.entries(maps as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    }
    return out
  } catch {
    return {}
  }
}

function writeStore(store: Record<string, ViewedMap>): void {
  const kept = Object.fromEntries(
    Object.entries(store).filter(([, map]) => Object.keys(map).length > 0),
  )
  if (Object.keys(kept).length === 0) localStorage.removeItem(STORE_KEY)
  else localStorage.setItem(STORE_KEY, JSON.stringify(kept))
}

export function loadViewed(sessionId: string): ViewedMap {
  return readStore()[sessionId] ?? {}
}

export function saveViewed(sessionId: string, map: ViewedMap): ViewedMap {
  const store = readStore()
  store[sessionId] = map
  writeStore(store)
  return map
}

export function dropViewedSessions(liveIds: ReadonlySet<string>): void {
  const store = readStore()
  const kept = Object.fromEntries(
    Object.entries(store).filter(([sessionId]) => liveIds.has(sessionId)),
  )
  if (Object.keys(kept).length !== Object.keys(store).length) writeStore(kept)
}
