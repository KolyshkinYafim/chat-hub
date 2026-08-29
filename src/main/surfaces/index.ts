import { ipcMain } from "electron"
import { IpcChannels } from "@shared/ipc"
import {
  createDirectory,
  createFile,
  listDir,
  openFile,
  readFileText,
  saveFileText,
} from "./files"
import { readBoard, writeBoard } from "./board"
import {
  readProjectContext,
  seedProjectContext,
  setContextShare,
  writeContextDoc,
} from "./project-context"
import { listProjectFiles, searchProjectContent } from "./project-search"
import { readScripts, writeScripts } from "./scripts"
import { grantMediaUrl } from "./media"
import { TerminalSessions } from "./terminal"

export {
  createDirectory,
  createFile,
  listDir,
  openFile,
  readFileText,
  saveFileText,
} from "./files"
export { applyPlanToBoard, mergePlanIntoTodos, readBoard, writeBoard } from "./board"
export {
  projectContextBrief,
  readProjectContext,
  seedProjectContext,
  setContextShare,
  writeContextDoc,
} from "./project-context"
export { listProjectFiles, searchProjectContent } from "./project-search"
export {
  readScripts,
  runWorktreeCreateScripts,
  writeScripts,
  type ScriptExec,
  type ScriptExecResult,
} from "./scripts"
export {
  registerMediaProtocol,
  registerMediaScheme,
  revokeMediaGrants,
} from "./media"
export { TerminalSessions, type TerminalSink } from "./terminal"
export {
  hardenWebviewHost,
  isAllowedGuestUrl,
  isMediaGuestUrl,
} from "./browser"
export {
  resolveContainedPath,
  resolveCreatablePath,
  resolveWorkspaceRoot,
} from "./paths"

export type WindowOwnerLookup = (webContentsId: number) => number | null

export function registerSurfaceIpc(
  terminals: TerminalSessions,
  ownerOf: WindowOwnerLookup = () => null,
): void {
  ipcMain.handle(IpcChannels.boardRead, (_e, cwd: unknown) => readBoard(cwd))

  ipcMain.handle(IpcChannels.boardWrite, (_e, cwd: unknown, board: unknown) =>
    writeBoard(cwd, board),
  )

  ipcMain.handle(IpcChannels.contextRead, (_e, cwd: unknown) =>
    readProjectContext(cwd),
  )

  ipcMain.handle(
    IpcChannels.contextWriteDoc,
    (_e, cwd: unknown, id: unknown, text: unknown) =>
      writeContextDoc(cwd, id, text),
  )

  ipcMain.handle(IpcChannels.contextSeed, (_e, cwd: unknown, id: unknown) =>
    seedProjectContext(cwd, id),
  )

  ipcMain.handle(
    IpcChannels.contextSetShare,
    (_e, cwd: unknown, share: unknown) => setContextShare(cwd, share),
  )

  ipcMain.handle(IpcChannels.scriptsList, (_e, cwd: unknown) => readScripts(cwd))

  ipcMain.handle(IpcChannels.scriptsSave, (_e, cwd: unknown, scripts: unknown) =>
    writeScripts(cwd, scripts),
  )

  ipcMain.handle(IpcChannels.projectFiles, (_e, cwd: unknown) =>
    listProjectFiles(cwd),
  )

  ipcMain.handle(IpcChannels.projectSearch, (_e, cwd: unknown, query: unknown) =>
    searchProjectContent(cwd, query),
  )

  ipcMain.handle(IpcChannels.listDir, (_e, cwd: unknown, relPath: unknown) =>
    listDir(cwd, relPath),
  )

  ipcMain.handle(IpcChannels.readFile, (_e, cwd: unknown, relPath: unknown) =>
    readFileText(cwd, relPath),
  )

  ipcMain.handle(IpcChannels.openFile, (e, cwd: unknown, relPath: unknown) => {
    const owner = ownerOf(e.sender.id)
    return openFile(cwd, relPath, (grant) => grantMediaUrl(grant, owner))
  })

  ipcMain.handle(
    IpcChannels.saveFile,
    (_e, cwd: unknown, relPath: unknown, text: unknown, stamp: unknown) =>
      saveFileText(cwd, relPath, text, stamp),
  )

  ipcMain.handle(IpcChannels.createFile, (_e, cwd: unknown, relPath: unknown) =>
    createFile(cwd, relPath),
  )

  ipcMain.handle(
    IpcChannels.createDirectory,
    (_e, cwd: unknown, relPath: unknown) => createDirectory(cwd, relPath),
  )

  ipcMain.handle(
    IpcChannels.termStart,
    (_e, cwd: unknown, cols: unknown, rows: unknown) =>
      terminals.start(cwd, cols, rows),
  )

  ipcMain.on(IpcChannels.termWrite, (_e, ptyId: unknown, data: unknown) => {
    terminals.write(ptyId, data)
  })

  ipcMain.on(
    IpcChannels.termResize,
    (_e, ptyId: unknown, cols: unknown, rows: unknown) => {
      terminals.resize(ptyId, cols, rows)
    },
  )

  ipcMain.on(IpcChannels.termKill, (_e, ptyId: unknown) => {
    terminals.kill(ptyId)
  })
}
