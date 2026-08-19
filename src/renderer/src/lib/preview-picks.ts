import type { PickTarget } from "./pick-script"

export type PreviewPick = PickTarget & { id: string; note: string }

export type PreviewPickInput = Omit<PreviewPick, "id">

const store = new Map<string, PreviewPick[]>()
const listeners = new Set<() => void>()

let nextId = 0

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function addPick(
  sessionId: string,
  input: PreviewPickInput,
): PreviewPick {
  nextId += 1
  const pick: PreviewPick = { id: `pp-${nextId}`, ...input }
  store.set(sessionId, [...(store.get(sessionId) ?? []), pick])
  notify()
  return pick
}

export function removePick(sessionId: string, id: string): void {
  const existing = store.get(sessionId)
  if (!existing?.some((p) => p.id === id)) return
  const remaining = existing.filter((p) => p.id !== id)
  if (remaining.length === 0) store.delete(sessionId)
  else store.set(sessionId, remaining)
  notify()
}

export function listPicks(sessionId: string): PreviewPick[] {
  return [...(store.get(sessionId) ?? [])]
}

export function clearPicks(sessionId: string): void {
  if (!store.has(sessionId)) return
  store.delete(sessionId)
  notify()
}

export function onPreviewPicksChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function prunePreviewPicks(liveSessionIds: ReadonlySet<string>): void {
  for (const sessionId of [...store.keys()]) {
    if (!liveSessionIds.has(sessionId)) store.delete(sessionId)
  }
}

function labelFor(pick: PreviewPick): string {
  const base = pick.text === "" ? pick.tag : `${pick.tag} "${pick.text}"`
  return pick.href === undefined
    ? `${base} (${pick.selector})`
    : `${base} (${pick.selector}) → ${pick.href}`
}

/** One composer-ready message from a batch of page picks, or null for none. */
export function buildPickMessage(
  url: string,
  picks: readonly PreviewPick[],
): string | null {
  if (picks.length === 0) return null
  const entries = picks.map((p) => `${labelFor(p)}\n${p.note}`)
  return `Notes on the page ${url}:\n\n${entries.join("\n\n")}`
}
