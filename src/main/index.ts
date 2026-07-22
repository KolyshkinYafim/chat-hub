import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { join } from "node:path"
import { realpathSync, statSync } from "node:fs"
import { IpcChannels } from "@shared/ipc"
import type { CreateSessionInput, ProviderId } from "@shared/types"
import { PROVIDERS } from "@shared/types"
import { listProviderInfo } from "./adapters"
import { EventBus } from "./event-bus"
import { SessionMonitorBridge } from "./bridge"
import { MonitorCommandBridge } from "./command-bridge"
import { NotificationService } from "./notifications"
import { Persistence } from "./persistence"
import { SessionManager } from "./session-manager"
import { getGitCheckout, gitCommitAll } from "./git"
import { SettingsStore } from "./settings"
import type { PermissionMode } from "@shared/permission"
import type { ProviderConfig } from "@shared/settings-types"
import { probeAllProviders } from "./provider-probe"
import { openLoginTerminal } from "./terminal-launch"

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

function assertExistingDir(path: string): string {
  const real = realpathSync(path)
  if (!statSync(real).isDirectory()) {
    throw new Error(`Not a directory: ${path}`)
  }
  return real
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Chat Hub",
    backgroundColor: "#0c0d10",
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

function registerIpc(
  sm: SessionManager,
  bridge: SessionMonitorBridge,
  settings: SettingsStore,
): void {
  ipcMain.handle(IpcChannels.getSnapshot, () => sm.getSnapshot())
  ipcMain.handle(IpcChannels.listSessions, () => sm.listSessions())
  ipcMain.handle(IpcChannels.getMessages, (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Invalid sessionId")
    }
    return sm.getMessages(sessionId)
  })
  ipcMain.handle(IpcChannels.createSession, async (_e, input: unknown) => {
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
      model: typeof raw.model === "string" ? raw.model : undefined,
    })
  })
  ipcMain.handle(
    IpcChannels.sendMessage,
    async (_e, sessionId: unknown, text: unknown, opts?: unknown) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof text !== "string") {
        throw new Error("Invalid message")
      }
      const o =
        opts && typeof opts === "object"
          ? (opts as {
              effort?: "low" | "medium" | "high" | "max"
              attachments?: string[]
            })
          : undefined
      return sm.sendMessage(sessionId, text, o)
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
  ipcMain.handle(IpcChannels.setActiveSession, (_e, sessionId: unknown) => {
    if (sessionId !== null && typeof sessionId !== "string") {
      throw new Error("Invalid sessionId")
    }
    sm.setActiveSession(sessionId)
    return sm.getSnapshot()
  })
  ipcMain.handle(IpcChannels.listProviders, () => listProviderInfo())
  ipcMain.handle(IpcChannels.getBridgePath, () => bridge.path)

  ipcMain.handle(IpcChannels.pickFolder, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openDirectory", "createDirectory"],
      title: "Open project folder",
      buttonLabel: "Use folder",
    })
    if (result.canceled || !result.filePaths[0]) return null
    return assertExistingDir(result.filePaths[0])
  })

  ipcMain.handle(IpcChannels.openPath, async (_e, target: unknown) => {
    if (typeof target !== "string" || !target) {
      throw new Error("Invalid path")
    }
    const path = assertExistingDir(target)
    const err = await shell.openPath(path)
    if (err) throw new Error(err)
    return true
  })

  ipcMain.handle(IpcChannels.openInEditor, async (_e, target: unknown) => {
    if (typeof target !== "string" || !target) {
      throw new Error("Invalid path")
    }
    const path = assertExistingDir(target)
    // Prefer VS Code / Cursor if present; else Finder
    const { spawn } = await import("node:child_process")
    const tryCmd = (cmd: string, args: string[]) =>
      new Promise<boolean>((resolve) => {
        const p = spawn(cmd, args, { stdio: "ignore", detached: true })
        p.on("error", () => resolve(false))
        p.unref()
        // assume ok if spawn didn't error immediately
        setTimeout(() => resolve(true), 80)
      })
    if (await tryCmd("cursor", [path])) return "cursor"
    if (await tryCmd("code", [path])) return "code"
    await shell.openPath(path)
    return "finder"
  })

  ipcMain.handle(IpcChannels.getGitInfo, async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || !cwd) {
      return { branch: "no-git", dirty: false, root: null }
    }
    try {
      return await getGitCheckout(assertExistingDir(cwd))
    } catch {
      // Missing/demo paths (e.g. seeded /Users/dev/…) should not break UI
      return { branch: "no-git", dirty: false, root: null }
    }
  })

  ipcMain.handle(
    IpcChannels.gitCommit,
    async (_e, cwd: unknown, message: unknown) => {
      if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
      if (typeof message !== "string" || !message.trim()) {
        throw new Error("Commit message required")
      }
      return gitCommitAll(assertExistingDir(cwd), message.trim())
    },
  )

  ipcMain.handle(IpcChannels.getSettings, async () => {
    const snap = settings.snapshot
    const statuses = await probeAllProviders(snap.providers)
    return {
      permissionMode: snap.permissionMode,
      providers: snap.providers,
      statuses,
    }
  })

  ipcMain.handle(
    IpcChannels.setPermissionMode,
    async (_e, mode: unknown) => {
      if (mode !== "yolo" && mode !== "acceptEdits" && mode !== "default") {
        throw new Error("Invalid permission mode")
      }
      const next = await sm.setPermissionMode(mode as PermissionMode)
      return { permissionMode: next }
    },
  )

  ipcMain.handle(IpcChannels.getProviderStatuses, async () => {
    return probeAllProviders(settings.snapshot.providers)
  })

  ipcMain.handle(
    IpcChannels.setProviderConfig,
    async (_e, id: unknown, patch: unknown) => {
      if (typeof id !== "string") throw new Error("Invalid provider id")
      if (!PROVIDER_IDS.has(id as ProviderId)) throw new Error("Unknown provider")
      if (!patch || typeof patch !== "object") throw new Error("Invalid config")
      const p = patch as ProviderConfig
      await settings.setProviderConfig(id as ProviderId, {
        binaryPath:
          typeof p.binaryPath === "string" ? p.binaryPath : undefined,
        defaultModel:
          typeof p.defaultModel === "string" ? p.defaultModel : undefined,
      })
      const statuses = await probeAllProviders(settings.snapshot.providers)
      return {
        providers: settings.snapshot.providers,
        statuses,
      }
    },
  )

  ipcMain.handle(IpcChannels.providerLogin, async (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid provider id")
    const map: Record<string, string> = {
      claude: "claude auth login",
      grok: "grok login",
      opencode: "opencode auth login",
      codex: "codex login",
    }
    const cmd = map[id]
    if (!cmd) throw new Error("No login command for provider")
    openLoginTerminal(cmd)
    return { ok: true, command: cmd }
  })

  ipcMain.handle(
    IpcChannels.setSessionModel,
    (_e, sessionId: unknown, model: unknown) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof model !== "string") throw new Error("Invalid model")
      return sm.setSessionModel(sessionId, model)
    },
  )

  ipcMain.handle(
    IpcChannels.setSessionTitle,
    (_e, sessionId: unknown, title: unknown) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof title !== "string") throw new Error("Invalid title")
      return sm.setSessionTitle(sessionId, title)
    },
  )

  ipcMain.handle(IpcChannels.pickFiles, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openFile", "multiSelections"],
      title: "Attach files",
      buttonLabel: "Attach",
    })
    if (result.canceled) return [] as string[]
    return result.filePaths
  })
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.setName("Chat Hub")
  }

  // Ensure Homebrew / local bins visible to Electron GUI apps on macOS
  if (process.platform === "darwin") {
    const extras = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      join(process.env.HOME ?? "", ".local", "bin"),
      join(process.env.HOME ?? "", ".grok", "bin"),
    ]
    process.env.PATH = [
      ...extras,
      process.env.PATH ?? "",
    ]
      .filter(Boolean)
      .join(":")
  }

  const userData = app.getPath("userData")
  const bus = new EventBus()
  const persistence = new Persistence(Persistence.defaultPath(userData))
  const settings = new SettingsStore(SettingsStore.defaultPath(userData))
  await settings.load()
  const bridge = new SessionMonitorBridge(SessionMonitorBridge.defaultPath())
  const notifications = new NotificationService((id) =>
    manager?.getSession(id),
  )
  manager = new SessionManager(
    bus,
    persistence,
    bridge,
    notifications,
    settings,
  )
  await manager.init()

  bus.on((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannels.hubEvent, event)
    }
  })

  registerIpc(manager, bridge, settings)
  createWindow()

  commandBridge = new MonitorCommandBridge(manager, (sessionId) => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow()
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

app.on("before-quit", (e) => {
  commandBridge?.stop()
  if (!manager) return
  e.preventDefault()
  void manager.flush().finally(() => {
    manager = null
    app.exit(0)
  })
})

