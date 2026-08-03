import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Board, BoardNote, BoardTodo } from "@shared/surfaces"
import { resolveWorkspaceRoot } from "./paths"

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

/** Coerce whatever is on disk into a valid Board — the file is hand-editable. */
function coerce(raw: unknown): Board {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const todos: BoardTodo[] = Array.isArray(o.todos)
    ? o.todos
        .map((t, i): BoardTodo | null => {
          if (!t || typeof t !== "object") return null
          const r = t as Record<string, unknown>
          const text = str(r.text).trim()
          if (!text) return null
          return {
            id: str(r.id) || `t${i}-${num(r.createdAt)}`,
            text,
            done: r.done === true,
            createdAt: num(r.createdAt),
          }
        })
        .filter((t): t is BoardTodo => t !== null)
    : []
  const notes: BoardNote[] = Array.isArray(o.notes)
    ? o.notes
        .map((n, i): BoardNote | null => {
          if (!n || typeof n !== "object") return null
          const r = n as Record<string, unknown>
          const text = str(r.text).trim()
          if (!text) return null
          return {
            id: str(r.id) || `n${i}-${num(r.createdAt)}`,
            text,
            createdAt: num(r.createdAt),
          }
        })
        .filter((n): n is BoardNote => n !== null)
    : []
  return { todos, notes, updatedAt: num(o.updatedAt) || undefined }
}

/** Read a workspace's board, or an empty board when the file is absent. */
export async function readBoard(cwd: unknown): Promise<Board> {
  const file = boardFile(cwd)
  try {
    const board = coerce(JSON.parse(await readFile(file, "utf8")))
    if (board.updatedAt === undefined) {
      // The agent edits board.json by hand and rarely stamps `updatedAt`; without
      // it the renderer's change-poll compares 0 !== 0 and never adopts the edit.
      // Fall back to the file's mtime so out-of-band writes still surface live.
      try {
        board.updatedAt = (await stat(file)).mtimeMs
      } catch {
        /* stat can't fail right after a successful read, but stay defensive */
      }
    }
    return board
  } catch {
    // Missing file / bad JSON: an empty board is the honest "nothing yet" state.
    return { todos: [], notes: [] }
  }
}

/** Persist a board (creating `.chathub/` on first write). */
export async function writeBoard(cwd: unknown, board: unknown): Promise<Board> {
  const file = boardFile(cwd)
  const next = { ...coerce(board), updatedAt: Date.now() }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(next, null, 2))
  return next
}
