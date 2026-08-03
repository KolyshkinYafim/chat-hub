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

export type FileContents = {
  path: string
  text: string
  truncated: boolean
  binary: boolean
}

export type TerminalChunk = { ptyId: string; data: string }

export type TerminalExit = { ptyId: string; exitCode: number }

export type SurfaceBridge = {
  listDir: (cwd: string, relPath: string) => Promise<DirListing>
  readFileText: (cwd: string, relPath: string) => Promise<FileContents>
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
