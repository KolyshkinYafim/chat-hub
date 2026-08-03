export type SurfaceKind = "browser" | "terminal" | "files" | "diff"

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
