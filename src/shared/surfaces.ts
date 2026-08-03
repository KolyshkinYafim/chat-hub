export type SurfaceKind = "browser" | "terminal" | "files" | "diff" | "board"

/** One task on the project board. `done` toggles from the UI or the agent. */
export type BoardTodo = {
  id: string
  text: string
  done: boolean
  createdAt: number
}

/** A dynamic note the agent (or user) drops onto the board. */
export type BoardNote = {
  id: string
  text: string
  createdAt: number
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

export type FileContents = {
  path: string
  text: string
  truncated: boolean
  binary: boolean
}

export type TerminalChunk = { ptyId: string; data: string }

export type TerminalExit = { ptyId: string; exitCode: number }

export type TerminalHandle = { ptyId: string }

export const FILE_READ_LIMIT_BYTES = 512 * 1024

export const BINARY_SNIFF_BYTES = 8 * 1024

export const HIDDEN_FROM_LISTING: readonly string[] = [
  ".git",
  "node_modules",
  ".DS_Store",
]
