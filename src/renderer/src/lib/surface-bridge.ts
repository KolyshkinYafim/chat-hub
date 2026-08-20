import type { BrowserActivity } from "@shared/browser"
import type {
  SurfaceOpenRequest,
  SurfaceStateReport,
} from "@shared/surface-control"
import type { ProjectScript, ScriptsFile } from "@shared/scripts"
import type { ContextDocId, ProjectContext } from "@shared/project-context"
import type {
  Board,
  DirEntry,
  DirListing,
  FileContents,
  FileSaved,
  FileStamp,
  OpenedFile,
  ProjectSearchHit,
  TerminalChunk,
  TerminalExit,
} from "@shared/surfaces"

// The canonical surface types live in @shared/surfaces (shared with main and
// preload); this module only re-exports them so renderer callers keep their
// existing import paths.
export type {
  ContextDoc,
  ContextDocId,
  ProjectContext,
} from "@shared/project-context"
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
  ProjectSearchHit,
  SurfaceKind,
  TerminalChunk,
  TerminalExit,
} from "@shared/surfaces"
import { humanizeFsError } from "./fs-error"

export type { BrowserActivity } from "@shared/browser"

export type {
  SurfaceOpenRequest,
  SurfaceStateReport,
} from "@shared/surface-control"

export type GrokTrustStatus = { trusted: boolean; path: string }

export type SurfaceBridge = {
  projectFiles: (cwd: string) => Promise<string[]>
  projectSearch: (cwd: string, query: string) => Promise<ProjectSearchHit[]>
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
  contextRead: (cwd: string) => Promise<ProjectContext>
  contextWriteDoc: (
    cwd: string,
    id: ContextDocId,
    text: string,
  ) => Promise<ProjectContext>
  contextSeed: (cwd: string, id?: ContextDocId) => Promise<ProjectContext>
  contextSetShare: (cwd: string, share: boolean) => Promise<ProjectContext>
  scriptsList: (cwd: string) => Promise<ScriptsFile>
  scriptsSave: (cwd: string, scripts: ProjectScript[]) => Promise<ScriptsFile>
  browserAttach: (sessionId: string, webContentsId: number) => Promise<boolean>
  browserDetach: (sessionId: string) => Promise<boolean>
  onBrowserActivity: (cb: (event: BrowserActivity) => void) => () => void
  onBrowserOpen: (cb: (sessionId: string) => void) => () => void
  onSurfaceOpen: (cb: (request: SurfaceOpenRequest) => void) => () => void
  reportSurfaceState: (state: SurfaceStateReport) => void
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
  return humanizeFsError(message.replace(IPC_WRAPPER, ""))
}
