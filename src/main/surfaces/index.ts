import { ipcMain } from "electron"
import { IpcChannels } from "@shared/ipc"
import { listDir, readFileText } from "./files"
import { readBoard, writeBoard } from "./board"
import { TerminalSessions } from "./terminal"

export { listDir, readFileText } from "./files"
export { readBoard, writeBoard } from "./board"
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
