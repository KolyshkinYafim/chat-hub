export type SurfaceKind = "browser" | "terminal" | "files" | "diff" | "board"

export type BoardTodo = {
  id: string
  text: string
  done: boolean
  createdAt: number
}

export type BoardNote = { id: string; text: string; createdAt: number }

export type Board = {
  todos: BoardTodo[]
  notes: BoardNote[]
  updatedAt?: number
}

export type DirEntry = {
  name: string
  path: string
  kind: "file" | "dir"
  size?: number
}

export type DirListing = {
  path: string
  entries: DirEntry[]
}

export type FileStamp = { mtimeMs: number; size: number }

export type FileContents = {
  path: string
  text: string
  truncated: boolean
  binary: boolean
  stamp: FileStamp
}

export type MediaKind = "text" | "image" | "video" | "audio" | "pdf" | "binary"

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

export type SurfaceBridge = {
  listDir: (cwd: string, relPath: string) => Promise<DirListing>
  readFileText: (cwd: string, relPath: string) => Promise<FileContents>
  openFile: (cwd: string, relPath: string) => Promise<OpenedFile>
  saveFile: (
    cwd: string,
    relPath: string,
    text: string,
    stamp: FileStamp,
  ) => Promise<FileSaved>
  termStart: (
    cwd: string,
    cols: number,
    rows: number,
  ) => Promise<{ ptyId: string }>
  termWrite: (ptyId: string, data: string) => void
  termResize: (ptyId: string, cols: number, rows: number) => void
  termKill: (ptyId: string) => void
  onTerminalData: (cb: (chunk: TerminalChunk) => void) => () => void
  onTerminalExit: (cb: (exit: TerminalExit) => void) => () => void
  boardRead: (cwd: string) => Promise<Board>
  boardWrite: (cwd: string, board: Board) => Promise<Board>
}

export function surfaceBridge(): SurfaceBridge {
  return window.chatHub as unknown as SurfaceBridge
}

export function surfaceBridgeReady(): boolean {
  const bridge = window.chatHub as unknown as Partial<SurfaceBridge> | undefined
  return typeof bridge?.listDir === "function"
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
