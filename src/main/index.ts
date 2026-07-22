import { app, BrowserWindow, ipcMain, shell } from "electron"
import { join } from "node:path"
import { IpcChannels } from "@shared/ipc"
import type { CreateSessionInput } from "@shared/types"
import { PROVIDERS } from "@shared/types"
import { EventBus } from "./event-bus"
import { SessionMonitorBridge } from "./bridge"
import { NotificationService } from "./notifications"
import { Persistence } from "./persistence"
import { SessionManager } from "./session-manager"

let mainWindow: BrowserWindow | null = null
let manager: SessionManager | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Chat Hub",
    backgroundColor: "#0f1115",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
  }
}

function registerIpc(sm: SessionManager, bridge: SessionMonitorBridge): void {
  ipcMain.handle(IpcChannels.getSnapshot, () => sm.getSnapshot())
  ipcMain.handle(IpcChannels.listSessions, () => sm.listSessions())
  ipcMain.handle(IpcChannels.getMessages, (_e, sessionId: string) =>
    sm.getMessages(sessionId),
  )
  ipcMain.handle(
    IpcChannels.createSession,
    async (_e, input: CreateSessionInput) => sm.createSession(input),
  )
  ipcMain.handle(
    IpcChannels.sendMessage,
    async (_e, sessionId: string, text: string) =>
      sm.sendMessage(sessionId, text),
  )
  ipcMain.handle(IpcChannels.abortSession, async (_e, sessionId: string) =>
    sm.abortSession(sessionId),
  )
  ipcMain.handle(IpcChannels.deleteSession, async (_e, sessionId: string) =>
    sm.deleteSession(sessionId),
  )
  ipcMain.handle(
    IpcChannels.setActiveSession,
    (_e, sessionId: string | null) => {
      sm.setActiveSession(sessionId)
      return sm.getSnapshot()
    },
  )
  ipcMain.handle(IpcChannels.listProviders, () => PROVIDERS)
  ipcMain.handle(IpcChannels.getBridgePath, () => bridge.path)
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.setName("Chat Hub")
  }

  const userData = app.getPath("userData")
  const bus = new EventBus()
  const persistence = new Persistence(Persistence.defaultPath(userData))
  const bridge = new SessionMonitorBridge(
    SessionMonitorBridge.defaultPath(userData),
  )
  const notifications = new NotificationService((id) =>
    manager?.getSession(id),
  )
  manager = new SessionManager(bus, persistence, bridge, notifications)
  await manager.init()

  bus.on((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannels.hubEvent, event)
    }
  })

  registerIpc(manager, bridge)
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  void manager?.flush()
})
