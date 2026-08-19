import { createSessionListStore } from "./session-list-store"

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

const store = createSessionListStore<DiffComment>("dc")

export function addComment(
  sessionId: string,
  input: DiffCommentInput,
): DiffComment {
  return store.add(sessionId, input)
}

export function updateComment(sessionId: string, id: string, text: string): void {
  store.update(sessionId, id, { text })
}

export function removeComment(sessionId: string, id: string): void {
  store.remove(sessionId, id)
}

export function listComments(sessionId: string): DiffComment[] {
  return store.list(sessionId)
}

export function clearComments(sessionId: string): void {
  store.clear(sessionId)
}

export function onDiffCommentsChanged(cb: () => void): () => void {
  return store.subscribe(cb)
}

export function pruneDiffComments(liveSessionIds: ReadonlySet<string>): void {
  store.prune(liveSessionIds)
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
