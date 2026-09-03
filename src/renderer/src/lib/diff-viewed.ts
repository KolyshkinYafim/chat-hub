export type ViewedMap = Record<string, string>

export function hashDiff(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

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

const viewedKey = (sessionId: string): string =>
  `chat-hub.diffViewed.${sessionId}`

export function loadViewed(sessionId: string): ViewedMap {
  const raw = localStorage.getItem(viewedKey(sessionId))
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    )
  } catch {
    return {}
  }
}

export function saveViewed(sessionId: string, map: ViewedMap): ViewedMap {
  const key = viewedKey(sessionId)
  if (Object.keys(map).length === 0) localStorage.removeItem(key)
  else localStorage.setItem(key, JSON.stringify(map))
  return map
}
