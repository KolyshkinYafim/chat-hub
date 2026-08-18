import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Board, BoardNote, BoardTodo } from "@shared/surfaces"
import { resolveWorkspaceRoot } from "./paths"
import { isEnoent } from "../fs-util"

/** Absolute path of a workspace's board file (validated, contained in cwd). */
function boardFile(cwd: unknown): string {
  const root = resolveWorkspaceRoot(cwd)
  return join(root, ".chathub", "board.json")
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

/** Both board item kinds share the fields the merge cares about. */
type BoardItem = BoardTodo | BoardNote

/**
 * Position-independent id for an item the agent hand-wrote without one.
 * Deriving it from the array index (the old `t${i}-...`) meant a delete or a
 * reorder silently renamed every later row, so a `done` toggle landed on the
 * wrong task. A uuid is stable, and `readBoard` writes it back to the file so
 * the same row keeps the same id across reads.
 */
function freshId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

function isItemish(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && str((v as Record<string, unknown>).text).trim() !== ""
}

/**
 * Fill in missing ids on the *raw* parsed JSON, in place, so the object can be
 * written back verbatim — everything else the agent put in the file (unknown
 * fields, key order inside items) survives the backfill untouched.
 * Returns true when something was added.
 */
function backfillIds(raw: unknown): boolean {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  let changed = false
  for (const [key, prefix] of [
    ["todos", "t"],
    ["notes", "n"],
  ] as const) {
    const list = o[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!isItemish(item)) continue
      if (str(item.id)) continue
      item.id = freshId(prefix)
      changed = true
    }
  }
  return changed
}

/**
 * Coerce whatever is on disk into a valid Board — the file is hand-editable.
 *
 * `stamp` is the fallback per-item `updatedAt` for items that don't carry one.
 * On read that's the file's own stamp (board `updatedAt`, else mtime): a hand
 * edit is only observable through the file's mtime, so treating unstamped items
 * as "written when the file was last written" is the honest reading, and it
 * keeps agent edits from looking older than a UI snapshot. On write it's 0,
 * which marks the item as unstamped so the merge can stamp it with `now`.
 */
function coerce(raw: unknown, stamp: number): Board {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const todos: BoardTodo[] = Array.isArray(o.todos)
    ? o.todos
        .map((t): BoardTodo | null => {
          if (!t || typeof t !== "object") return null
          const r = t as Record<string, unknown>
          const text = str(r.text).trim()
          if (!text) return null
          return {
            id: str(r.id) || freshId("t"),
            text,
            done: r.done === true,
            createdAt: num(r.createdAt),
            updatedAt: num(r.updatedAt) || stamp,
          }
        })
        .filter((t): t is BoardTodo => t !== null)
    : []
  const notes: BoardNote[] = Array.isArray(o.notes)
    ? o.notes
        .map((n): BoardNote | null => {
          if (!n || typeof n !== "object") return null
          const r = n as Record<string, unknown>
          const text = str(r.text).trim()
          if (!text) return null
          return {
            id: str(r.id) || freshId("n"),
            text,
            createdAt: num(r.createdAt),
            updatedAt: num(r.updatedAt) || stamp,
          }
        })
        .filter((n): n is BoardNote => n !== null)
    : []
  return { todos, notes, updatedAt: num(o.updatedAt) || undefined }
}

/** Write via a temp file + rename so a crash can never leave a half board. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(tmp, text)
  try {
    await rename(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }
}

async function mtimeMs(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Persist ids generated during a read. Best-effort by design: this is a write
 * the user never asked for, so it must never turn a readable board into an
 * error or clobber a concurrent agent edit. We re-check the mtime we read at
 * and bail if the file moved under us; on any failure the caller still gets the
 * in-memory ids (they just won't be stable until the next successful backfill).
 */
async function persistBackfill(
  file: string,
  raw: unknown,
  readAt: number,
): Promise<number> {
  try {
    if ((await mtimeMs(file)) !== readAt) return 0
    await writeAtomic(file, JSON.stringify(raw, null, 2))
    return await mtimeMs(file)
  } catch {
    /* leave the agent's file exactly as it was */
    return 0
  }
}

/**
 * Read a workspace's board.
 *
 * Error contract (deliberately the same shape as `writeBoard`): a board that
 * has never been written is not an error and reads as an empty board. Anything
 * else — invalid/missing workspace, unreadable file, malformed JSON — throws,
 * because the old "swallow everything and return an empty board" made a broken
 * or unreachable file look like an empty one, and the next write then merged
 * against that phantom empty board and dropped real content. Failing loudly
 * shows the user the actual problem and leaves the file alone.
 */
export async function readBoard(cwd: unknown): Promise<Board> {
  const file = boardFile(cwd)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if (isEnoent(e)) return { todos: [], notes: [] }
    throw e
  }
  const readAt = await mtimeMs(file)
  const raw: unknown = JSON.parse(text)
  // The agent edits board.json by hand and rarely stamps `updatedAt`; without
  // it the renderer's change-poll compares 0 !== 0 and never adopts the edit.
  // Fall back to the file's mtime so out-of-band writes still surface live.
  const explicit = num((raw as Record<string, unknown> | null)?.updatedAt)
  let stamp = explicit || readAt
  if (backfillIds(raw)) {
    // Report the post-backfill mtime, otherwise the caller's snapshot version
    // is older than the file it just caused to be rewritten and every item
    // would look "changed since your snapshot" on the next write.
    const after = await persistBackfill(file, raw, readAt)
    if (after && !explicit) stamp = after
  }
  const board = coerce(raw, stamp)
  if (board.updatedAt === undefined) board.updatedAt = stamp || undefined
  return board
}

function sameContent(a: BoardItem, b: BoardItem): boolean {
  return (
    a.text === b.text &&
    a.createdAt === b.createdAt &&
    (a as BoardTodo).done === (b as BoardTodo).done
  )
}

/**
 * Merge one list (todos or notes) per item instead of per board.
 *
 * Rules, all at item granularity (last-writer-wins per *item*, so a UI toggle
 * and a concurrent agent edit of a different row both survive):
 *
 *  - id only in `incoming` → a new item; stamp it if it arrived unstamped.
 *  - id in both → the disk copy wins when it changed after the writer's
 *    snapshot (`d.updatedAt > max(item.updatedAt, base)`), i.e. you cannot
 *    overwrite an edit you never saw. Otherwise the writer wins, and is
 *    restamped with `now` when its content actually differs from disk. A
 *    writer that stamps the item it edited (`updatedAt = now`) always wins,
 *    which is how a genuine simultaneous edit of the same row resolves
 *    last-writer-wins; a writer that only echoes its snapshot back never
 *    clobbers a fresher agent edit.
 *  - id only on disk → see below.
 *
 * DELETION vs "the writer hasn't seen it yet". An item missing from `incoming`
 * is ambiguous: either the writer deleted it, or it was added on disk after the
 * writer last read the board. We disambiguate with `base` — the board-level
 * `updatedAt` the writer echoes back, i.e. the version of its snapshot. If the
 * disk item is newer than that snapshot (`updatedAt > base`) the writer never
 * saw it, so it is kept; otherwise the writer saw it and left it out, which is
 * a delete. No tombstones needed, so the file stays hand-writable and doesn't
 * accumulate graveyard entries. A caller that sends no board `updatedAt` at all
 * has no snapshot to compare against, and `base` is +Infinity: its list is
 * taken as authoritative (omission = delete), which is the pre-merge behaviour.
 */
function mergeItems<T extends BoardItem>(
  disk: T[],
  incoming: T[],
  base: number,
  now: number,
): T[] {
  const byId = new Map(disk.map((i) => [i.id, i]))
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of incoming) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const d = byId.get(item.id)
    if (!d) {
      out.push({ ...item, updatedAt: item.updatedAt || now })
      continue
    }
    const known = Math.max(item.updatedAt ?? 0, base)
    if ((d.updatedAt ?? 0) > known) {
      out.push(d)
      continue
    }
    out.push(sameContent(item, d) ? item : { ...item, updatedAt: now })
  }
  // Items the writer never saw, appended in disk order after the writer's list.
  for (const d of disk) {
    if (seen.has(d.id)) continue
    if ((d.updatedAt ?? 0) > base) out.push(d)
  }
  return out
}

/**
 * Persist a board (creating `.chathub/` on first write), merging per item with
 * whatever is on disk so a concurrent agent edit isn't clobbered. Throws for
 * the same conditions `readBoard` throws for — an unreadable or malformed file
 * is surfaced instead of being overwritten.
 *
 * The read-merge-write is not atomic against a file the agent writes directly;
 * the window is a few milliseconds and the poll re-reads, so we don't take a
 * lock over a hand-editable file.
 */
export async function writeBoard(cwd: unknown, board: unknown): Promise<Board> {
  const file = boardFile(cwd)
  const now = Date.now()
  const incoming = coerce(board, 0)
  const base = incoming.updatedAt ?? Number.POSITIVE_INFINITY
  const disk = await readBoard(cwd)
  const next: Board = {
    todos: mergeItems(disk.todos, incoming.todos, base, now),
    notes: mergeItems(disk.notes, incoming.notes, base, now),
    updatedAt: now,
  }
  await writeAtomic(file, JSON.stringify(next, null, 2))
  return next
}
