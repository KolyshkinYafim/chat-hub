import type { PickTarget } from "./pick-script"
import { createSessionListStore } from "./session-list-store"

export type PreviewPick = PickTarget & { id: string; note: string }

export type PreviewPickInput = Omit<PreviewPick, "id">

const store = createSessionListStore<PreviewPick>("pp")

export function addPick(
  sessionId: string,
  input: PreviewPickInput,
): PreviewPick {
  return store.add(sessionId, input)
}

export function removePick(sessionId: string, id: string): void {
  store.remove(sessionId, id)
}

export function listPicks(sessionId: string): PreviewPick[] {
  return store.list(sessionId)
}

export function clearPicks(sessionId: string): void {
  store.clear(sessionId)
}

export function onPreviewPicksChanged(cb: () => void): () => void {
  return store.subscribe(cb)
}

export function prunePreviewPicks(liveSessionIds: ReadonlySet<string>): void {
  store.prune(liveSessionIds)
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
