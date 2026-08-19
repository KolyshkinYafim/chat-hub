import type { BrowserActivity } from "@shared/browser"
import type { ProjectScript, ScriptsFile } from "@shared/scripts"
import type {
  Board,
  DirEntry,
  DirListing,
  FileContents,
  FileSaved,
  FileStamp,
  OpenedFile,
  TerminalChunk,
  TerminalExit,
} from "@shared/surfaces"

// The canonical surface types live in @shared/surfaces (shared with main and
// preload); this module only re-exports them so renderer callers keep their
// existing import paths.
export type {
  Board,
  BoardNote,
  BoardTodo,
  DirEntry,
  DirListing,
  FileContents,
  FileSaved,
  FileStamp,
  MediaKind,
  OpenedFile,
  SurfaceKind,
  TerminalChunk,
  TerminalExit,
} from "@shared/surfaces"

export type { BrowserActivity } from "@shared/browser"

export type GrokTrustStatus = { trusted: boolean; path: string }

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
  createFile: (cwd: string, relPath: string) => Promise<FileSaved>
  createDirectory: (cwd: string, relPath: string) => Promise<DirEntry>
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
  scriptsList: (cwd: string) => Promise<ScriptsFile>
  scriptsSave: (cwd: string, scripts: ProjectScript[]) => Promise<ScriptsFile>
  browserAttach: (sessionId: string, webContentsId: number) => Promise<boolean>
  browserDetach: (sessionId: string) => Promise<boolean>
  onBrowserActivity: (cb: (event: BrowserActivity) => void) => () => void
  onBrowserOpen: (cb: (sessionId: string) => void) => () => void
  grokTrustStatus: (cwd: string) => Promise<GrokTrustStatus>
  grokTrustFolder: (cwd: string) => Promise<boolean>
}

export function surfaceBridge(): SurfaceBridge {
  return window.chatHub as unknown as SurfaceBridge
}

export function surfaceBridgeReady(): boolean {
  const bridge = window.chatHub as unknown as Partial<SurfaceBridge> | undefined
  return typeof bridge?.listDir === "function"
}

/** Electron wraps every rejected `invoke` in a sentence of its own — drop it. */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/

export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(IPC_WRAPPER, "")
}
