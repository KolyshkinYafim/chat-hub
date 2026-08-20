import type { MediaKind } from "./file-kind"

export type { MediaKind } from "./file-kind"

export type SurfaceKind =
  | "browser"
  | "terminal"
  | "files"
  | "diff"
  | "history"
  | "board"
  | "context"
  | "fleet"

export const BOARD_TODO_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const

export type BoardTodoStatus = (typeof BOARD_TODO_STATUSES)[number]

/**
 * One task on the project board. `done` stays as a boolean so hand-written
 * `board.json` files and older UI snapshots keep working; `status` is the
 * richer state. Reads without `status` derive it from `done`.
 *
 * `updatedAt` is per item so concurrent writes merge row by row instead of
 * board by board; it's optional because hand-written files don't have it
 * (reads fall back to the file's stamp).
 */
export type BoardTodo = {
  id: string
  text: string
  done: boolean
  status?: BoardTodoStatus
  blockedReason?: string
  result?: string
  /** `plan` when the row was mirrored from a session TodoWrite / plan card. */
  source?: "user" | "plan"
  /** Stable match key for plan mirroring (`id:…` or `text:…`). */
  planKey?: string
  createdAt: number
  updatedAt?: number
}

export function isBoardTodoStatus(value: unknown): value is BoardTodoStatus {
  return (
    typeof value === "string" &&
    (BOARD_TODO_STATUSES as readonly string[]).includes(value)
  )
}

/** Effective status: explicit field, else the legacy `done` flag. */
export function boardTodoStatus(todo: Pick<BoardTodo, "done" | "status">): BoardTodoStatus {
  if (todo.status && isBoardTodoStatus(todo.status)) return todo.status
  return todo.done ? "done" : "pending"
}

/** Still on the plate: not done and not cancelled. */
export function isBoardTodoOpen(todo: Pick<BoardTodo, "done" | "status">): boolean {
  const status = boardTodoStatus(todo)
  return status !== "done" && status !== "cancelled"
}

/** Live work: currently moving, or stuck. */
export function isBoardTodoNow(todo: Pick<BoardTodo, "done" | "status">): boolean {
  const status = boardTodoStatus(todo)
  return status === "in_progress" || status === "blocked"
}

export function withBoardTodoStatus(
  todo: BoardTodo,
  status: BoardTodoStatus,
): BoardTodo {
  return {
    ...todo,
    status,
    done: status === "done",
  }
}

/** A dynamic note the agent (or user) drops onto the board. */
export type BoardNote = {
  id: string
  text: string
  createdAt: number
  updatedAt?: number
}

/**
 * Per-project context, persisted at `<cwd>/.chathub/board.json`. The agent can
 * edit that file directly (it has workspace access) and the UI reflects it; the
 * UI can also edit and write it back. Kept deliberately human-writable.
 */
export type Board = {
  todos: BoardTodo[]
  notes: BoardNote[]
  updatedAt?: number
}

export const BOARD_REL_PATH = ".chathub/board.json"

export type DirEntryKind = "file" | "dir"

export type DirEntry = {
  name: string
  path: string
  kind: DirEntryKind
  size?: number
}

export type DirListing = {
  path: string
  entries: DirEntry[]
}

/** Identity of the bytes a read saw, so a later save can refuse a stale write. */
export type FileStamp = { mtimeMs: number; size: number }

export type FileContents = {
  path: string
  text: string
  truncated: boolean
  binary: boolean
  stamp: FileStamp
}

/**
 * Everything the viewer needs to pick a renderer in one round trip. `text` is
 * filled for anything editable (plain text and SVG source); `dataUrl` carries
 * small images inline; `streamUrl` points video/audio at the media protocol so
 * a 500 MB file never becomes a base64 string.
 */
export type OpenedFile = {
  path: string
  absolutePath: string
  kind: MediaKind
  mime: string
  size: number
  stamp: FileStamp
  text: string | null
  truncated: boolean
  dataUrl: string | null
  streamUrl: string | null
  unavailable: string | null
}

export type FileSaved = { path: string; stamp: FileStamp }

export type TerminalChunk = { ptyId: string; data: string }

export type TerminalExit = { ptyId: string; exitCode: number }

export type TerminalHandle = { ptyId: string }

export const FILE_READ_LIMIT_BYTES = 512 * 1024

export const BINARY_SNIFF_BYTES = 8 * 1024

export const FILE_WRITE_LIMIT_BYTES = 4 * 1024 * 1024

export const INLINE_IMAGE_LIMIT_BYTES = 16 * 1024 * 1024

/** Custom scheme for video/audio, so playback streams instead of inlining. */
export const MEDIA_SCHEME = "chathub-media"

/** Matched by the renderer to offer a reload instead of a generic failure. */
export const STALE_WRITE_MESSAGE = "changed on disk since it was opened"

export const HIDDEN_FROM_LISTING: readonly string[] = [
  ".git",
  "node_modules",
  ".DS_Store",
]

/** One content-search match: workspace-relative path, 1-based line, excerpt. */
export type ProjectSearchHit = {
  path: string
  line: number
  text: string
}

export const PROJECT_FILE_LIST_LIMIT = 20_000

export const PROJECT_SEARCH_LIMIT = 300

export const PROJECT_SEARCH_PER_FILE_LIMIT = 20

export const PROJECT_SEARCH_EXCERPT_CHARS = 200
