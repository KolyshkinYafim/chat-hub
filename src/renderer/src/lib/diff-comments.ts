export type DiffLineKind = "add" | "del" | "ctx"

export type DiffComment = {
  id: string
  file: string
  line: number
  lineText: string
  kind: DiffLineKind
  text: string
}

export type DiffCommentInput = Omit<DiffComment, "id">

const store = new Map<string, DiffComment[]>()
const listeners = new Set<() => void>()

let nextId = 0

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function addComment(
  sessionId: string,
  input: DiffCommentInput,
): DiffComment {
  nextId += 1
  const comment: DiffComment = { id: `dc-${nextId}`, ...input }
  const existing = store.get(sessionId) ?? []
  store.set(sessionId, [...existing, comment])
  notify()
  return comment
}

export function updateComment(sessionId: string, id: string, text: string): void {
  const existing = store.get(sessionId)
  if (!existing?.some((c) => c.id === id)) return
  store.set(
    sessionId,
    existing.map((c) => (c.id === id ? { ...c, text } : c)),
  )
  notify()
}

export function removeComment(sessionId: string, id: string): void {
  const existing = store.get(sessionId)
  if (!existing?.some((c) => c.id === id)) return
  const remaining = existing.filter((c) => c.id !== id)
  if (remaining.length === 0) store.delete(sessionId)
  else store.set(sessionId, remaining)
  notify()
}

export function listComments(sessionId: string): DiffComment[] {
  return [...(store.get(sessionId) ?? [])]
}

export function clearComments(sessionId: string): void {
  if (!store.has(sessionId)) return
  store.delete(sessionId)
  notify()
}

export function onDiffCommentsChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function pruneDiffComments(liveSessionIds: ReadonlySet<string>): void {
  for (const sessionId of [...store.keys()]) {
    if (!liveSessionIds.has(sessionId)) store.delete(sessionId)
  }
}

const MARKER: Record<DiffLineKind, string> = { add: "+", del: "-", ctx: " " }

/** One composer-ready message from a batch of line comments, or null for none. */
export function buildReviewMessage(
  comments: readonly DiffComment[],
): string | null {
  if (comments.length === 0) return null
  const ordered = [...comments].sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  )
  const entries = ordered.map(
    (c) => `${c.file}:${c.line}\n> ${MARKER[c.kind]} ${c.lineText}\n${c.text}`,
  )
  return `Review comments on the current diff:\n\n${entries.join("\n\n")}`
}
