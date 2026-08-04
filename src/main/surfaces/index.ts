import { ipcMain } from "electron"
import { IpcChannels } from "@shared/ipc"
import { listDir, openFile, readFileText, saveFileText } from "./files"
import { readBoard, writeBoard } from "./board"
import { grantMediaUrl } from "./media"
import { TerminalSessions } from "./terminal"

export { listDir, openFile, readFileText, saveFileText } from "./files"
export { readBoard, writeBoard } from "./board"
export {
  registerMediaProtocol,
  registerMediaScheme,
  revokeMediaGrants,
} from "./media"
export { TerminalSessions, type TerminalSink } from "./terminal"
export { hardenWebviewHost, isAllowedGuestUrl } from "./browser"
export { resolveContainedPath, resolveWorkspaceRoot } from "./paths"

export function registerSurfaceIpc(terminals: TerminalSessions): void {
  ipcMain.handle(IpcChannels.boardRead, (_e, cwd: unknown) => readBoard(cwd))

  ipcMain.handle(IpcChannels.boardWrite, (_e, cwd: unknown, board: unknown) =>
    writeBoard(cwd, board),
  )

  ipcMain.handle(IpcChannels.listDir, (_e, cwd: unknown, relPath: unknown) =>
    listDir(cwd, relPath),
  )

  ipcMain.handle(IpcChannels.readFile, (_e, cwd: unknown, relPath: unknown) =>
    readFileText(cwd, relPath),
  )

  ipcMain.handle(IpcChannels.openFile, (_e, cwd: unknown, relPath: unknown) =>
    openFile(cwd, relPath, grantMediaUrl),
  )

  ipcMain.handle(
    IpcChannels.saveFile,
    (_e, cwd: unknown, relPath: unknown, text: unknown, stamp: unknown) =>
      saveFileText(cwd, relPath, text, stamp),
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
