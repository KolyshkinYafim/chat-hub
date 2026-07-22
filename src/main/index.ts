import { app, BrowserWindow, ipcMain, shell } from "electron"
import { join } from "node:path"
import { IpcChannels } from "@shared/ipc"
import type { CreateSessionInput, ProviderId } from "@shared/types"
import { PROVIDERS } from "@shared/types"
import { EventBus } from "./event-bus"
import { SessionMonitorBridge } from "./bridge"
import { MonitorCommandBridge } from "./command-bridge"
import { NotificationService } from "./notifications"
import { Persistence } from "./persistence"
import { SessionManager } from "./session-manager"

let mainWindow: BrowserWindow | null = null
let manager: SessionManager | null = null
let commandBridge: MonitorCommandBridge | null = null

const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id))

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.protocol === "http:"
  } catch {
    return false
  }
}

function isRendererNavigationAllowed(url: string): boolean {
  if (process.env.ELECTRON_RENDERER_URL) {
    return url.startsWith(process.env.ELECTRON_RENDERER_URL)
  }
  return url.startsWith("file://")
}

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
      sandbox: true,
    },
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: "deny" }
  })

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isRendererNavigationAllowed(url)) {
      event.preventDefault()
    }
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
  ipcMain.handle(IpcChannels.getMessages, (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Invalid sessionId")
    }
    return sm.getMessages(sessionId)
  })
  ipcMain.handle(
    IpcChannels.createSession,
    async (_e, input: unknown) => {
      if (!input || typeof input !== "object") {
        throw new Error("Invalid createSession payload")
      }
      const raw = input as CreateSessionInput
      if (!PROVIDER_IDS.has(raw.provider as ProviderId)) {
        throw new Error("Unknown provider")
      }
      return sm.createSession({
        provider: raw.provider,
        title: typeof raw.title === "string" ? raw.title : undefined,
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
        project: typeof raw.project === "string" ? raw.project : undefined,
      })
    },
  )
  ipcMain.handle(
    IpcChannels.sendMessage,
    async (_e, sessionId: unknown, text: unknown) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof text !== "string") {
        throw new Error("Invalid message")
      }
      return sm.sendMessage(sessionId, text)
    },
  )
  ipcMain.handle(IpcChannels.abortSession, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Invalid sessionId")
    }
    return sm.abortSession(sessionId)
  })
  ipcMain.handle(IpcChannels.deleteSession, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Invalid sessionId")
    }
    return sm.deleteSession(sessionId)
  })
  ipcMain.handle(
    IpcChannels.setActiveSession,
    (_e, sessionId: unknown) => {
      if (sessionId !== null && typeof sessionId !== "string") {
        throw new Error("Invalid sessionId")
      }
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
  const bridge = new SessionMonitorBridge(SessionMonitorBridge.defaultPath())
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

  commandBridge = new MonitorCommandBridge(manager, (sessionId) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    }
    mainWindow?.show()
    mainWindow?.focus()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannels.hubEvent, {
        type: "session.active",
        sessionId,
      })
    }
  })
  commandBridge.start()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  commandBridge?.stop()
  void manager?.flush()
})
