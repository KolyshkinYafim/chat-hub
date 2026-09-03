import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron"
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
import { wireDockBadge, type DockBadge } from "./dock-badge"
import { Persistence } from "./persistence"
import { ProjectStore } from "./project-store"
import { SessionManager, type SendOpts } from "./session-manager"
import { PermissionBroker } from "./permission-broker"
import { seedFromSessions, UsageLedger } from "./usage-ledger"
import {
  checkoutBranch,
  getFileDiff,
  getGitCheckout,
  getWorkingCopy,
  gitCommitAll,
  gitCommitStaged,
  gitPush,
  gitCreatePr,
  listSessionWorktrees,
  pruneSessionWorktrees,
  removeSessionWorktree,
  gitInit,
  findGitRepositories,
  listBranches,
  listCommits,
  getCommitDetail,
  stagePaths,
  unstagePaths,
  getHunkSummary,
  stageFileHunk,
  unstageFileHunk,
} from "./git"
import { listCheckpoints } from "./checkpoints"
import { sanitizeGeneralPatch, SettingsStore } from "./settings"
import type { PermissionMode } from "@shared/permission"
import type {
  BuildInfo,
  DataPaths,
  ProviderConfig,
  StorageStats,
} from "@shared/settings-types"
import { readBuildInfo } from "./build-info"
import { dirStats } from "./storage-stats"
import {
  probeAllProviders,
  testProvider,
  type ProbeInput,
} from "./provider-probe"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { openLoginTerminal } from "./terminal-launch"
import { HOME_ENV } from "./instances"
import type { ProviderInstance } from "@shared/settings-types"
import {
  hardenWebviewHost,
  registerMediaProtocol,
  registerMediaScheme,
  registerSurfaceIpc,
  revokeMediaGrants,
  TerminalSessions,
} from "./surfaces"
import { installDeveloperMenu } from "./developer-menu"
import {
  createZoomController,
  openingBounds,
  trackWindowState,
  type ZoomController,
} from "./window-state"
import {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  windowsToReopen,
  type WindowState,
} from "@shared/window-bounds"
import { windowQuery } from "@shared/window-identity"
import { pickWindowForSession, WindowRegistry } from "./window-registry"
import { parseCockpitFlags, type CockpitWindow } from "@shared/cockpit"
import { resolveTheme, themeBackground } from "@shared/theme"
import {
  applyCockpitChrome,
  shouldGlass,
  watchReducedTransparency,
} from "./cockpit-window"
import { DEFAULT_ZOOM_LEVEL } from "@shared/zoom"
import {
  appendMcpPathsToGitignore,
  materializeMcpForProject,
  mcpListForRenderer,
  probeMcpStatuses,
  readMcpConfig,
  removeMcpServer,
  setMcpServerEnabled,
  upsertMcpServer,
} from "./mcp"
import type { McpServerDef } from "@shared/mcp"
import {
  defaultGrokTrustPath,
  grokFolderTrusted,
  trustGrokFolder,
} from "./grok-trust"
import {
  cancelHandyTranscription,
  handyInstalled,
  toggleHandyTranscription,
} from "./voice-handy"
import { inspectAttachmentPaths } from "./attachments"
import { ProviderStatusCacheStore } from "./provider-status-cache"
import { ProviderStatusRefresher } from "./provider-status-refresh"
import { chatHubBrowserSocketPath } from "@shared/bridge-path"
import { BrowserControl } from "./surfaces/browser-control"
import { SurfaceControl } from "./surfaces/surface-control"
import { BrowserService } from "./browser-service"
import { browserMcpServerPath, registerBrowserMcp } from "./browser-mcp"

const REAL_PROVIDER_IDS: ProviderId[] = [
  "claude",
  "grok",
  "opencode",
  "codex",
  "mock",
]

/** Build probe inputs for the default instance of each provider + every extra. */
function buildProbeInputs(settings: SettingsStore): ProbeInput[] {
  const out: ProbeInput[] = []
  for (const id of REAL_PROVIDER_IDS) {
    const cfg = settings.getProviderConfig(id)
    out.push({
      provider: id,
      instanceId: id,
      isExtra: false,
      binaryPath: cfg.binaryPath,
      defaultModel: cfg.defaultModel,
      enabled: cfg.enabled,
      // Decrypted names only: a sealed key that no longer opens (repackaged app,
      // settings copied to another Mac) must stop counting as "connected".
      envKeys: Object.keys(settings.getProviderEnv(id)),
    })
  }
  for (const inst of settings.listInstances()) {
    const r = settings.resolveInstance(inst.id)
    if (!r) continue
    out.push({
      provider: r.provider,
      instanceId: r.instanceId,
      isExtra: true,
      label: r.label,
      binaryPath: r.binaryPath,
      defaultModel: r.defaultModel,
      enabled: r.enabled,
      envKeys: [],
      env: r.env,
      homeDir: r.homeDir,
    })
  }
  return out
}

type HubWindow = {
  id: number
  window: BrowserWindow
  zoom: ZoomController
  sessions: Set<string>
  cockpit: CockpitWindow
}

const windows = new WindowRegistry<HubWindow>()
let manager: SessionManager | null = null
let commandBridge: MonitorCommandBridge | null = null
let permissions: PermissionBroker | null = null
let dockBadge: DockBadge | null = null
// createWindow also runs from `activate` and the monitor bridge, long after
// bootstrap handed the store around, so the window path reads it from here.
let settingsStore: SettingsStore | null = null

const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id))

function liveWindows(): HubWindow[] {
  return windows.values().filter((hub) => !hub.window.isDestroyed())
}

function hubForWebContents(webContentsId: number): HubWindow | null {
  return (
    liveWindows().find((hub) => hub.window.webContents.id === webContentsId) ??
    null
  )
}

function sendToRenderer(channel: string, payload: unknown): void {
  for (const hub of liveWindows()) {
    hub.window.webContents.send(channel, payload)
  }
}

function sendToWindow(hub: HubWindow, channel: string, payload: unknown): void {
  if (hub.window.isDestroyed()) return
  hub.window.webContents.send(channel, payload)
}

function showWindow(hub: HubWindow): void {
  if (hub.window.isDestroyed()) return
  if (hub.window.isMinimized()) hub.window.restore()
  hub.window.show()
  hub.window.focus()
}

function windowForSession(sessionId: string | null): HubWindow {
  const shows = new Map<number, ReadonlySet<string>>(
    liveWindows().map((hub) => [hub.id, hub.sessions]),
  )
  const pick = pickWindowForSession(sessionId, shows, windows.recency())
  const existing = pick === null ? undefined : windows.get(pick)
  if (existing && !existing.window.isDestroyed()) return existing
  return createWindow({ sessionId })
}

function focusSession(sessionId: string | null): void {
  const hub = windowForSession(sessionId)
  showWindow(hub)
  if (!sessionId) return
  sendToWindow(hub, IpcChannels.hubEvent, {
    type: "session.active",
    sessionId,
  })
}

const terminals = new TerminalSessions({
  data: (chunk) => sendToRenderer(IpcChannels.termData, chunk),
  exit: (event) => sendToRenderer(IpcChannels.termExit, event),
})

const browserControl = new BrowserControl({
  onActivity: (activity) =>
    sendToRenderer(IpcChannels.browserActivity, activity),
})

/**
 * Deliberately window-quiet: a dock tool may switch what the panel shows, but
 * never raises, focuses or resizes the window the way the browser path does —
 * the user may be typing somewhere else entirely.
 */
const surfaceControl = new SurfaceControl({
  session: (sessionId) => manager?.getSession(sessionId) ?? null,
  note: (sessionId, text) => manager?.note(sessionId, text),
  open: (request) => sendToRenderer(IpcChannels.surfaceOpen, request),
})

const browserService = new BrowserService(
  chatHubBrowserSocketPath(),
  browserControl,
  {
    requestOpen: (sessionId) => {
      const hub = windowForSession(sessionId)
      if (!hub.window.isDestroyed()) hub.window.show()
      sendToWindow(hub, IpcChannels.browserOpen, sessionId)
    },
    surfaces: (request) => surfaceControl.handle(request),
  },
)

function registerBrowserIpc(): void {
  ipcMain.handle(
    IpcChannels.browserAttach,
    (_e, sessionId: string, webContentsId: number) =>
      browserService.attach(sessionId, webContentsId),
  )
  ipcMain.handle(IpcChannels.browserDetach, (_e, sessionId: string) =>
    browserService.detach(sessionId),
  )
  ipcMain.on(IpcChannels.surfaceState, (_e, state: unknown) => {
    surfaceControl.setState(state)
  })
}

function registerWindowIpc(): void {
  ipcMain.on(IpcChannels.attentionCount, (event, count: unknown) => {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      return
    }
    const hub = hubForWebContents(event.sender.id)
    if (!hub) return
    dockBadge?.setRendererCount(hub.id, count)
  })

  ipcMain.on(IpcChannels.windowSessions, (event, sessionIds: unknown) => {
    const hub = hubForWebContents(event.sender.id)
    if (!hub) return
    if (!Array.isArray(sessionIds)) return
    hub.sessions = new Set(
      sessionIds.filter((id): id is string => typeof id === "string" && id !== ""),
    )
  })

  ipcMain.handle(IpcChannels.windowOpen, (_e, sessionId: unknown) => {
    const seed = typeof sessionId === "string" && sessionId ? sessionId : null
    const hub = createWindow({ fresh: true, sessionId: seed })
    showWindow(hub)
    return hub.id
  })
}

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

const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const

/**
 * sendMessage opts come from the renderer and end up in CLI argv verbatim, so a
 * value starting with "-" would be read as another flag — past the Hub's own
 * permission policy. Whitelist instead of casting.
 */
function normalizeSendOpts(opts: unknown): SendOpts | undefined {
  if (!opts || typeof opts !== "object") return undefined
  const raw = opts as { effort?: unknown; attachments?: unknown }
  const clean: SendOpts = {}
  if (
    typeof raw.effort === "string" &&
    (EFFORTS as readonly string[]).includes(raw.effort)
  ) {
    clean.effort = raw.effort as SendOpts["effort"]
  }
  if (Array.isArray(raw.attachments)) {
    const files = raw.attachments.filter(
      (p): p is string =>
        typeof p === "string" && !p.startsWith("-") && isExistingFile(p),
    )
    if (files.length > 0) clean.attachments = files
  }
  return clean
}

function normalizeSessionIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((id): id is string => typeof id === "string" && id !== "")
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function assertExistingDir(path: string): string {
  const real = realpathSync(path)
  if (!statSync(real).isDirectory()) {
    throw new Error(`Not a directory: ${path}`)
  }
  return real
}

const bootStart = Date.now()
let snapshotServed = false
function bootMark(label: string): void {
  console.log(`[boot] ${label} +${Date.now() - bootStart}ms`)
}

export type CreateWindowOptions = {
  windowId?: number
  state?: WindowState | null
  fresh?: boolean
  sessionId?: string | null
}

const CASCADE_STEP = 28

function cascadeFrom(previous: BrowserWindow | null): WindowState | null {
  if (!previous || previous.isDestroyed()) return null
  const bounds = previous.getNormalBounds()
  return {
    bounds: {
      ...bounds,
      x: bounds.x + CASCADE_STEP,
      y: bounds.y + CASCADE_STEP,
    },
    maximized: false,
  }
}

function currentThemeBackground(): string {
  return themeBackground(
    resolveTheme(
      settingsStore?.general.themeId,
      settingsStore?.general.customThemes,
    ),
  )
}

function cockpitFlagsFor(saved: WindowState | null): CockpitWindow {
  return parseCockpitFlags(process.argv, process.env, saved?.cockpit)
}

function applyHubCockpit(hub: HubWindow): void {
  applyCockpitChrome(
    hub.window,
    hub.cockpit.enabled && !hub.window.isFullScreen(),
    hub.cockpit.vibrancy,
    currentThemeBackground(),
  )
}

function createWindow(options: CreateWindowOptions = {}): HubWindow {
  const id = options.windowId ?? windows.nextId()
  const saved =
    options.state ?? cascadeFrom(windows.mostRecent()?.window ?? null)
  const cockpit = cockpitFlagsFor(saved)
  const themeBg = currentThemeBackground()
  const glass = shouldGlass(cockpit.enabled)
  const window = new BrowserWindow({
    ...openingBounds(saved),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: "Chat Hub",
    backgroundColor: glass ? "#00000000" : themeBg,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    ...(glass
      ? {
          vibrancy: cockpit.vibrancy,
          visualEffectState: "active" as const,
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      additionalArguments: cockpit.enabled
        ? [
            "--chat-hub-cockpit=1",
            `--chat-hub-cockpit-vibrancy=${cockpit.vibrancy}`,
          ]
        : [],
    },
  })

  if (saved?.maximized) window.maximize()

  const store = settingsStore

  const zoom = createZoomController(
    () => (window.isDestroyed() ? null : window.webContents),
    store?.zoomLevel ?? DEFAULT_ZOOM_LEVEL,
    (level) => {
      void store?.setZoomLevel(level).catch(() => {})
    },
  )

  const hub: HubWindow = { id, window, zoom, sessions: new Set(), cockpit }
  windows.add(id, hub)

  applyHubCockpit(hub)
  watchReducedTransparency(() => {
    for (const live of liveWindows()) applyHubCockpit(live)
  })
  window.on("enter-full-screen", () => applyHubCockpit(hub))
  window.on("leave-full-screen", () => applyHubCockpit(hub))

  if (store) {
    trackWindowState(window, () => rememberWindows())
  }
  window.on("focus", () => windows.touch(id))

  window.webContents.on("did-finish-load", () => zoom.apply())
  window.webContents.once("did-finish-load", () => bootMark("renderer.loaded"))

  window.on("closed", () => {
    windows.remove(id)
    dockBadge?.dropWindow(id)
    // Media tokens are capabilities into a workspace; nothing may replay them
    revokeMediaGrants(id)
    rememberWindows()
  })

  hardenWebviewHost(window.webContents, (url) => {
    void shell.openExternal(url)
  })
  installDeveloperMenu(() => focusedHubWindow()?.window ?? null, {
    zoom: {
      zoomIn: () => focusedHubWindow()?.zoom.zoomIn(),
      zoomOut: () => focusedHubWindow()?.zoom.zoomOut(),
      reset: () => focusedHubWindow()?.zoom.reset(),
    },
    newWindow: () => {
      createWindow({ fresh: true })
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: "deny" }
  })

  window.webContents.on("will-navigate", (event, url) => {
    if (!isRendererNavigationAllowed(url)) {
      event.preventDefault()
    }
  })

  if (cockpit.enabled) bootMark(`cockpit.${cockpit.vibrancy}`)

  const params = new URLSearchParams(
    windowQuery({
      windowId: id,
      fresh: options.fresh === true,
      sessionId: options.sessionId ?? null,
    }).slice(1),
  )
  if (cockpit.enabled) {
    params.set("cockpit", "1")
    params.set("vibrancy", cockpit.vibrancy)
  }
  const query = `?${params.toString()}`
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}${query}`)
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"), {
      search: query,
    })
  }
  return hub
}

function focusedHubWindow(): HubWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) {
    const hub = liveWindows().find((entry) => entry.window === focused)
    if (hub) return hub
  }
  const recent = windows.mostRecent()
  return recent && !recent.window.isDestroyed() ? recent : null
}

function rememberWindows(): void {
  const store = settingsStore
  if (!store) return
  const open = liveWindows().map((hub) => ({
    windowId: hub.id,
    bounds: hub.window.getNormalBounds(),
    maximized: hub.window.isMaximized(),
    cockpit: hub.cockpit.enabled,
  }))
  if (open.length === 0) return
  void store.setWindowStates(open).catch(() => {
  })
}

function openRememberedWindows(): HubWindow[] {
  const opened = windowsToReopen(settingsStore?.windowStates ?? null).map(
    ({ windowId, state }) => createWindow({ windowId, state }),
  )
  const front = opened[opened.length - 1]
  if (front) showWindow(front)
  return opened
}

export function registerIpc(
  sm: SessionManager,
  bridge: SessionMonitorBridge,
  settings: SettingsStore,
  projects: ProjectStore,
  userData: string,
  usageLedger: UsageLedger,
  providerStatuses: ProviderStatusRefresher,
  ready: Promise<void>,
): void {
  ipcMain.handle(IpcChannels.getSnapshot, async (_e, sessionIds: unknown) => {
    await ready
    if (!snapshotServed) {
      snapshotServed = true
      bootMark("snapshot.served")
    }
    return sm.getSnapshot(normalizeSessionIds(sessionIds))
  })
  ipcMain.handle(IpcChannels.usageSummary, async () => {
    await ready
    return usageLedger.summary()
  })
  ipcMain.handle(IpcChannels.listSessions, async () => {
    await ready
    return sm.listSessions()
  })
  ipcMain.handle(IpcChannels.getMessages, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Invalid sessionId")
    }
    await ready
    return sm.getMessages(sessionId)
  })
  ipcMain.handle(
    IpcChannels.loadArchivedMessages,
    async (
      _e,
      sessionId: unknown,
      beforeMessageId: unknown,
      limit: unknown,
    ) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      const before =
        beforeMessageId === null || beforeMessageId === undefined
          ? null
          : typeof beforeMessageId === "string"
            ? beforeMessageId
            : null
      const lim =
        typeof limit === "number" && Number.isFinite(limit) ? limit : 50
      return sm.loadArchivedMessages(sessionId, before, lim)
    },
  )
  ipcMain.handle(IpcChannels.hasArchivedMessages, (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Invalid sessionId")
    }
    return sm.hasArchivedMessages(sessionId)
  })
  ipcMain.handle(
    IpcChannels.loadArchiveThrough,
    async (
      _e,
      sessionId: unknown,
      beforeMessageId: unknown,
      targetMessageId: unknown,
    ) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof targetMessageId !== "string" || !targetMessageId) {
        throw new Error("Invalid targetMessageId")
      }
      const before =
        typeof beforeMessageId === "string" ? beforeMessageId : null
      return sm.loadArchiveThrough(sessionId, before, targetMessageId)
    },
  )
  ipcMain.handle(
    IpcChannels.searchArchivedTranscripts,
    async (_e, query: unknown, loadedFrom: unknown) => {
      if (typeof query !== "string") throw new Error("Invalid query")
      const from: Record<string, string | null> = {}
      if (loadedFrom && typeof loadedFrom === "object") {
        for (const [id, oldest] of Object.entries(loadedFrom)) {
          if (typeof id !== "string" || !id) continue
          from[id] = typeof oldest === "string" ? oldest : null
        }
      }
      return sm.searchArchivedTranscripts(query, from)
    },
  )
  ipcMain.handle(IpcChannels.createSession, async (_e, input: unknown) => {
    await ready
    if (!input || typeof input !== "object") {
      throw new Error("Invalid createSession payload")
    }
    const raw = input as CreateSessionInput
    if (!PROVIDER_IDS.has(raw.provider as ProviderId)) {
      throw new Error("Unknown provider")
    }
    const session = await sm.createSession({
      provider: raw.provider,
      instanceId: typeof raw.instanceId === "string" ? raw.instanceId : undefined,
      title: typeof raw.title === "string" ? raw.title : undefined,
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      project: typeof raw.project === "string" ? raw.project : undefined,
      model: typeof raw.model === "string" ? raw.model : undefined,
      worktree: raw.worktree === true,
    })
    // Pin the folder as a first-class project so it survives with no sessions.
    await projects.ensure(session.baseCwd ?? session.cwd, session.project)
    // Keep CLI-native MCP files in sync for this project (non-blocking).
    void materializeMcpForProject(session.cwd, (serverId) =>
      settings.getMcpEnv(serverId),
    ).catch((err) => console.error("[mcp] materialize on create failed", err))
    return session
  })
  ipcMain.handle(
    IpcChannels.sendMessage,
    async (_e, sessionId: unknown, text: unknown, opts?: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof text !== "string") {
        throw new Error("Invalid message")
      }
      return sm.sendMessage(sessionId, text, normalizeSendOpts(opts))
    },
  )
  ipcMain.handle(
    IpcChannels.cancelQueued,
    (_e, sessionId: unknown, queuedId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof queuedId !== "string" || !queuedId) {
        throw new Error("Invalid queued id")
      }
      return sm.cancelQueued(sessionId, queuedId)
    },
  )
  ipcMain.handle(IpcChannels.abortSession, async (_e, sessionId: unknown) => {
    await ready
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Invalid sessionId")
    }
    return sm.abortSession(sessionId)
  })
  ipcMain.handle(IpcChannels.deleteSession, async (_e, sessionId: unknown) => {
    await ready
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Invalid sessionId")
    }
    return sm.deleteSession(sessionId)
  })
  ipcMain.handle(IpcChannels.setActiveSession, async (_e, sessionId: unknown) => {
    await ready
    if (sessionId !== null && typeof sessionId !== "string") {
      throw new Error("Invalid sessionId")
    }
    sm.setActiveSession(sessionId)
    return sm.getSnapshot(sessionId === null ? [] : [sessionId])
  })
  ipcMain.handle(IpcChannels.listProviders, () => listProviderInfo())
  ipcMain.handle(IpcChannels.getBridgePath, () => bridge.path)

  ipcMain.handle(IpcChannels.pickFolder, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? focusedHubWindow()?.window ?? null
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
    const pref = settings.general.editor ?? "auto"
    if (pref === "finder") {
      await shell.openPath(path)
      return "finder"
    }
    const { spawn } = await import("node:child_process")
    const tryCmd = (cmd: string, args: string[]) =>
      new Promise<boolean>((resolve) => {
        const p = spawn(cmd, args, { stdio: "ignore", detached: true })
        p.on("error", () => resolve(false))
        p.unref()
        // assume ok if spawn didn't error immediately
        setTimeout(() => resolve(true), 80)
      })
    const order =
      pref === "cursor"
        ? ["cursor"]
        : pref === "code"
          ? ["code"]
          : ["cursor", "code"]
    for (const cmd of order) {
      if (await tryCmd(cmd, [path])) return cmd
    }
    await shell.openPath(path)
    return "finder"
  })

  ipcMain.handle(IpcChannels.gitInit, async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
    return gitInit(assertExistingDir(cwd))
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

  /** Every source-control handler takes the session cwd and re-validates it —
   *  the renderer holds the path, so it never gets to name the repo itself. */
  const gitCwd = (cwd: unknown): string => {
    if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
    return assertExistingDir(cwd)
  }
  const gitPaths = (paths: unknown): string[] => {
    if (!Array.isArray(paths)) throw new Error("Invalid paths")
    return paths.map((p) => {
      if (typeof p !== "string" || !p) throw new Error("Invalid path")
      return p
    })
  }

  ipcMain.handle(IpcChannels.gitStatus, async (_e, cwd: unknown) => {
    try {
      return await getWorkingCopy(gitCwd(cwd))
    } catch {
      // Seeded/demo cwds are not repos and must not surface as an error toast.
      return { root: null, branch: "no-git", ahead: 0, behind: 0, files: [] }
    }
  })
  ipcMain.handle(IpcChannels.gitRepositories, async (_e, cwd: unknown) =>
    findGitRepositories(gitCwd(cwd)),
  )

  ipcMain.handle(
    IpcChannels.gitDiff,
    async (
      _e,
      cwd: unknown,
      path: unknown,
      staged: unknown,
      untracked: unknown,
    ) => {
      if (typeof path !== "string" || !path) throw new Error("Invalid path")
      return getFileDiff(
        gitCwd(cwd),
        path,
        staged === true,
        untracked === true,
      )
    },
  )

  ipcMain.handle(IpcChannels.gitStage, (_e, cwd: unknown, paths: unknown) =>
    stagePaths(gitCwd(cwd), gitPaths(paths)),
  )

  ipcMain.handle(IpcChannels.gitUnstage, (_e, cwd: unknown, paths: unknown) =>
    unstagePaths(gitCwd(cwd), gitPaths(paths)),
  )

  const gitHunkArgs = (
    path: unknown,
    hunkIndex: unknown,
    hunk: unknown,
  ): [string, number, string] => {
    if (typeof path !== "string" || !path) throw new Error("Invalid path")
    if (
      typeof hunkIndex !== "number" ||
      !Number.isInteger(hunkIndex) ||
      hunkIndex < 0
    ) {
      throw new Error("Invalid hunk index")
    }
    if (typeof hunk !== "string" || !hunk.startsWith("@@")) {
      throw new Error("Invalid hunk")
    }
    return [path, hunkIndex, hunk]
  }

  ipcMain.handle(
    IpcChannels.gitStageHunk,
    (_e, cwd: unknown, path: unknown, hunkIndex: unknown, hunk: unknown) =>
      stageFileHunk(gitCwd(cwd), ...gitHunkArgs(path, hunkIndex, hunk)),
  )

  ipcMain.handle(
    IpcChannels.gitUnstageHunk,
    (_e, cwd: unknown, path: unknown, hunkIndex: unknown, hunk: unknown) =>
      unstageFileHunk(gitCwd(cwd), ...gitHunkArgs(path, hunkIndex, hunk)),
  )

  ipcMain.handle(IpcChannels.gitHunkSummary, (_e, cwd: unknown) =>
    getHunkSummary(gitCwd(cwd)),
  )

  ipcMain.handle(IpcChannels.gitBranches, (_e, cwd: unknown) =>
    listBranches(gitCwd(cwd)),
  )

  ipcMain.handle(IpcChannels.gitLog, (_e, cwd: unknown) =>
    listCommits(gitCwd(cwd)),
  )

  ipcMain.handle(IpcChannels.gitShow, (_e, cwd: unknown, sha: unknown) => {
    if (typeof sha !== "string" || !sha) throw new Error("Invalid commit")
    return getCommitDetail(gitCwd(cwd), sha)
  })

  ipcMain.handle(
    IpcChannels.gitCheckout,
    (_e, cwd: unknown, branch: unknown) => {
      if (typeof branch !== "string" || !branch) {
        throw new Error("Invalid branch")
      }
      return checkoutBranch(gitCwd(cwd), branch)
    },
  )

  ipcMain.handle(
    IpcChannels.gitCommitStaged,
    (_e, cwd: unknown, message: unknown) => {
      if (typeof message !== "string" || !message.trim()) {
        throw new Error("Commit message required")
      }
      return gitCommitStaged(gitCwd(cwd), message.trim())
    },
  )
  ipcMain.handle(IpcChannels.gitPush, (_e, cwd: unknown) =>
    gitPush(gitCwd(cwd)),
  )
  ipcMain.handle(
    IpcChannels.gitCreatePr,
    (_e, cwd: unknown, title: unknown, body: unknown, draft: unknown) => {
      if (typeof title !== "string" || !title.trim()) {
        throw new Error("PR title required")
      }
      return gitCreatePr(
        gitCwd(cwd),
        title,
        typeof body === "string" ? body : "",
        draft === true,
      )
    },
  )
  ipcMain.handle(IpcChannels.checkpointList, (_e, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Invalid session id")
    }
    const session = sm.getSession(sessionId)
    if (!session) return []
    return listCheckpoints(session.cwd, sessionId)
  })
  ipcMain.handle(
    IpcChannels.checkpointRevert,
    async (_e, sessionId: unknown, ref: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid session id")
      }
      if (typeof ref !== "string" || !ref) {
        throw new Error("Invalid checkpoint ref")
      }
      return sm.revertToCheckpoint(sessionId, ref)
    },
  )
  ipcMain.handle(IpcChannels.gitWorktrees, (_e, cwd: unknown) =>
    listSessionWorktrees(gitCwd(cwd)),
  )
  ipcMain.handle(
    IpcChannels.gitRemoveWorktree,
    async (_e, repoCwd: unknown, worktreePath: unknown) => {
      if (typeof worktreePath !== "string" || !worktreePath) {
        throw new Error("Invalid worktree path")
      }
      try {
        await removeSessionWorktree(gitCwd(repoCwd), worktreePath)
        return { ok: true, output: "Worktree removed" }
      } catch (err) {
        return {
          ok: false,
          output: err instanceof Error ? err.message : String(err),
        }
      }
    },
  )
  ipcMain.handle(IpcChannels.gitPruneWorktrees, async (_e, repoCwd: unknown) => {
    try {
      await pruneSessionWorktrees(gitCwd(repoCwd))
      return { ok: true, output: "Stale worktree entries pruned" }
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      }
    }
  })

  ipcMain.handle(IpcChannels.getSettings, () => {
    const snap = settings.snapshot
    const cached = providerStatuses.cached
    providerStatuses.kickIfStale()
    return {
      permissionMode: snap.permissionMode,
      providers: settings.redactedProviders(),
      instances: settings.listInstances(),
      general: snap.general,
      statuses: cached?.statuses ?? [],
      statusesCachedAt: cached?.cachedAt ?? null,
    }
  })

  ipcMain.handle(IpcChannels.setGeneralConfig, async (_e, patch: unknown) => {
    const next = await settings.setGeneralConfig(sanitizeGeneralPatch(patch))
    return { general: next.general }
  })

  ipcMain.handle(IpcChannels.setWindowCockpit, async (e, enabled: unknown) => {
    const on = enabled === true
    const hub = liveWindows().find(
      (entry) => entry.window.webContents === e.sender,
    )
    if (!hub) return { enabled: false }
    hub.cockpit = { ...hub.cockpit, enabled: on }
    applyHubCockpit(hub)
    rememberWindows()
    hub.window.webContents.send(IpcChannels.cockpitChanged, on)
    return { enabled: on }
  })

  ipcMain.handle(IpcChannels.getDataPaths, (): DataPaths => {
    const dataDir = join(userData, "data")
    let bridgeExists = false
    let bridgeSize = 0
    let bridgeMtime: number | null = null
    try {
      const st = statSync(bridge.path)
      bridgeExists = true
      bridgeSize = st.size
      bridgeMtime = st.mtimeMs
    } catch {
      /* bridge file not created yet */
    }
    return {
      dataDir,
      settingsPath: SettingsStore.defaultPath(userData),
      statePath: Persistence.defaultPath(userData),
      projectsPath: ProjectStore.defaultPath(userData),
      bridgePath: bridge.path,
      bridgeExists,
      bridgeSize,
      bridgeMtime,
    }
  })

  ipcMain.handle(
    IpcChannels.getBuildInfo,
    (): BuildInfo =>
      readBuildInfo({
        appPath: app.getAppPath(),
        packaged: app.isPackaged,
        version: app.getVersion(),
        versions: process.versions,
        platform: process.platform,
        arch: process.arch,
      }),
  )

  ipcMain.handle(
    IpcChannels.getStorageStats,
    async (): Promise<StorageStats> => {
      const sessions = sm.listSessions()
      let messageCount = 0
      for (const session of sessions) {
        messageCount += sm.getMessages(session.id).length
      }
      const { bytes, files } = await dirStats(join(userData, "data"))
      return {
        dataDirBytes: bytes,
        fileCount: files,
        sessionCount: sessions.length,
        archivedSessionCount: sessions.filter((s) => s.archived === true).length,
        messageCount,
      }
    },
  )

  ipcMain.handle(IpcChannels.revealPath, (_e, target: unknown) => {
    if (typeof target !== "string" || !target) throw new Error("Invalid path")
    if (!existsSync(target)) throw new Error(`Not found: ${target}`)
    shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle(IpcChannels.wipeSessions, async () => {
    await ready
    await sm.wipeSessions()
    return sm.getSnapshot()
  })

  ipcMain.handle(IpcChannels.listPermissions, () => permissions?.list() ?? [])

  ipcMain.handle(
    IpcChannels.resolvePermission,
    (_e, requestId: unknown, allow: unknown) => {
      if (typeof requestId !== "string" || !requestId) {
        throw new Error("Invalid requestId")
      }
      if (typeof allow !== "boolean") throw new Error("Invalid decision")
      return permissions?.resolve(requestId, allow ? "allow" : "deny") ?? false
    },
  )

  ipcMain.handle(
    IpcChannels.resolveInput,
    (_e, requestId: unknown, answers: unknown) => {
      if (typeof requestId !== "string" || !requestId) {
        throw new Error("Invalid input requestId")
      }
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
        throw new Error("Invalid input answers")
      }
      const clean: Record<string, string[]> = {}
      for (const [id, value] of Object.entries(answers)) {
        if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
          clean[id] = value
        }
      }
      return permissions?.resolveInput(requestId, clean) ?? false
    },
  )

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

  ipcMain.handle(
    IpcChannels.setSessionPermission,
    async (_e, sessionId: unknown, mode: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Session id required")
      }
      // undefined = drop the override; anything else must be a real mode, or a
      // typo would silently spawn the CLI with no permission flags at all.
      if (
        mode !== undefined &&
        mode !== "yolo" &&
        mode !== "acceptEdits" &&
        mode !== "default"
      ) {
        throw new Error("Invalid permission mode")
      }
      return sm.setSessionPermissionMode(
        sessionId,
        mode as PermissionMode | undefined,
      )
    },
  )

  ipcMain.handle(IpcChannels.getProviderStatuses, async () => {
    return providerStatuses.refresh()
  })

  ipcMain.handle(
    IpcChannels.setProviderConfig,
    async (_e, id: unknown, patch: unknown) => {
      if (typeof id !== "string") throw new Error("Invalid provider id")
      if (!PROVIDER_IDS.has(id as ProviderId)) throw new Error("Unknown provider")
      if (!patch || typeof patch !== "object") throw new Error("Invalid config")
      const p = patch as ProviderConfig
      let env: Record<string, string> | undefined
      if (p.env && typeof p.env === "object") {
        env = {}
        for (const [k, v] of Object.entries(p.env)) {
          if (typeof k === "string" && (typeof v === "string" || v == null)) {
            env[k] = typeof v === "string" ? v : ""
          }
        }
      }
      await settings.setProviderConfig(id as ProviderId, {
        binaryPath:
          typeof p.binaryPath === "string" ? p.binaryPath : undefined,
        defaultModel:
          typeof p.defaultModel === "string" ? p.defaultModel : undefined,
        enabled: typeof p.enabled === "boolean" ? p.enabled : undefined,
        env,
      })
      const statuses = await providerStatuses.refresh()
      return {
        providers: settings.redactedProviders(),
        statuses,
      }
    },
  )

  ipcMain.handle(IpcChannels.testProvider, async (_e, instanceId: unknown) => {
    if (typeof instanceId !== "string") throw new Error("Invalid instance id")
    const r = settings.resolveInstance(instanceId)
    if (!r) throw new Error("Unknown provider/instance")
    return testProvider({
      provider: r.provider,
      instanceId: r.instanceId,
      binaryPath: r.binaryPath,
      env: r.env,
      homeDir: r.homeDir,
    })
  })

  ipcMain.handle(IpcChannels.providerLogin, async (_e, instanceId: unknown) => {
    if (typeof instanceId !== "string") throw new Error("Invalid instance id")
    const r = settings.resolveInstance(instanceId)
    const provider = r?.provider ?? (instanceId as ProviderId)
    const map: Partial<Record<ProviderId, string>> = {
      claude: "claude auth login",
      grok: "grok login",
      opencode: "opencode auth login",
      codex: "codex login",
    }
    const base = map[provider]
    if (!base) throw new Error("No login command for provider")
    let cmd = base
    if (r?.homeDir) {
      const key = HOME_ENV[provider]
      if (key) cmd = `${key}=${JSON.stringify(r.homeDir)} ${base}`
    }
    openLoginTerminal(cmd)
    return { ok: true, command: cmd }
  })

  ipcMain.handle(
    IpcChannels.addInstance,
    async (_e, provider: unknown, patch: unknown) => {
      if (typeof provider !== "string" || !PROVIDER_IDS.has(provider as ProviderId)) {
        throw new Error("Unknown provider")
      }
      const p = (patch && typeof patch === "object" ? patch : {}) as Partial<ProviderInstance>
      await settings.addInstance(provider as ProviderId, {
        label: typeof p.label === "string" ? p.label : undefined,
        homeDir: typeof p.homeDir === "string" ? p.homeDir : undefined,
        binaryPath: typeof p.binaryPath === "string" ? p.binaryPath : undefined,
        defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : undefined,
      })
      return {
        instances: settings.listInstances(),
        statuses: await providerStatuses.refresh(),
      }
    },
  )

  ipcMain.handle(
    IpcChannels.updateInstance,
    async (_e, id: unknown, patch: unknown) => {
      if (typeof id !== "string") throw new Error("Invalid instance id")
      if (!patch || typeof patch !== "object") throw new Error("Invalid patch")
      const p = patch as Partial<ProviderInstance>
      await settings.updateInstance(id, {
        label: typeof p.label === "string" ? p.label : undefined,
        homeDir: typeof p.homeDir === "string" ? p.homeDir : undefined,
        binaryPath: typeof p.binaryPath === "string" ? p.binaryPath : undefined,
        defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : undefined,
        enabled: typeof p.enabled === "boolean" ? p.enabled : undefined,
      })
      return {
        instances: settings.listInstances(),
        statuses: await providerStatuses.refresh(),
      }
    },
  )

  ipcMain.handle(IpcChannels.removeInstance, async (_e, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid instance id")
    await settings.removeInstance(id)
    return {
      instances: settings.listInstances(),
      statuses: await providerStatuses.refresh(),
    }
  })

  ipcMain.handle(
    IpcChannels.setSessionModel,
    async (_e, sessionId: unknown, model: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof model !== "string") throw new Error("Invalid model")
      return sm.setSessionModel(sessionId, model)
    },
  )

  ipcMain.handle(
    IpcChannels.applySessionMode,
    async (_e, sessionId: unknown, patch: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      const p = (patch && typeof patch === "object" ? patch : {}) as {
        modeId?: unknown
        systemPrompt?: unknown
        model?: unknown
        permissionMode?: unknown
      }
      const str = (v: unknown) => (typeof v === "string" ? v : undefined)
      const mode = str(p.permissionMode)
      return sm.applySessionMode(sessionId, {
        modeId: str(p.modeId),
        systemPrompt: str(p.systemPrompt),
        model: str(p.model),
        permissionMode:
          mode === "yolo" || mode === "acceptEdits" || mode === "default"
            ? mode
            : undefined,
      })
    },
  )

  ipcMain.handle(
    IpcChannels.sessionSetSettled,
    async (_e, sessionId: unknown, settled: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof settled !== "boolean") throw new Error("Invalid settled flag")
      return sm.setSessionSettled(sessionId, settled)
    },
  )

  ipcMain.handle(
    IpcChannels.sessionSetFavorite,
    async (_e, sessionId: unknown, favorite: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof favorite !== "boolean") {
        throw new Error("Invalid favorite flag")
      }
      return sm.setSessionFavorite(sessionId, favorite)
    },
  )

  ipcMain.handle(
    IpcChannels.sessionRename,
    async (_e, sessionId: unknown, title: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof title !== "string") throw new Error("Invalid title")
      return sm.renameSession(sessionId, title)
    },
  )

  ipcMain.handle(
    IpcChannels.sessionSetArchived,
    async (_e, sessionId: unknown, archived: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      if (typeof archived !== "boolean") {
        throw new Error("Invalid archived flag")
      }
      return sm.setSessionArchived(sessionId, archived)
    },
  )

  ipcMain.handle(IpcChannels.sessionMigrateArchived, async (_e, ids: unknown) => {
    await ready
    if (!Array.isArray(ids)) throw new Error("Invalid ids")
    sm.migrateArchived(ids.filter((id): id is string => typeof id === "string"))
  })

  ipcMain.handle(
    IpcChannels.sessionRegenerateTitle,
    async (_e, sessionId: unknown) => {
      await ready
      if (typeof sessionId !== "string" || !sessionId) {
        throw new Error("Invalid sessionId")
      }
      return sm.regenerateTitle(sessionId)
    },
  )

  ipcMain.handle(IpcChannels.pickFiles, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? focusedHubWindow()?.window ?? null
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openFile", "multiSelections"],
      title: "Attach files",
      buttonLabel: "Attach",
    })
    if (result.canceled) return [] as string[]
    return result.filePaths
  })

  ipcMain.handle(IpcChannels.inspectAttachments, (_e, paths: unknown) => {
    if (!Array.isArray(paths)) return []
    return inspectAttachmentPaths(paths.filter((path): path is string => typeof path === "string"))
  })

  ipcMain.handle(
    IpcChannels.savePastedImage,
    async (_e, bytes: unknown, ext: unknown) => {
      // A screenshot on the clipboard has no path on disk, but the adapters can
      // only pass an attachment the CLI can @-reference — so we materialise it.
      // Through the view's own window, never the whole backing buffer: a typed
      // array over a slice would otherwise write its neighbours' bytes too.
      const buf = ArrayBuffer.isView(bytes)
        ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : null
      if (!buf || buf.length === 0) throw new Error("Empty image payload")
      const safeExt = typeof ext === "string" && /^[a-z0-9]{1,5}$/i.test(ext)
        ? ext.toLowerCase()
        : "png"
      const dir = join(app.getPath("userData"), "pasted")
      await mkdir(dir, { recursive: true })
      const name = `paste-${Date.now()}-${Math.round(Math.random() * 1e6)}.${safeExt}`
      const dest = join(dir, name)
      await writeFile(dest, buf)
      return dest
    },
  )

  ipcMain.handle(IpcChannels.readImageDataUrl, async (_e, target: unknown, requestedMax: unknown) => {
    if (typeof target !== "string" || !target) return null
    const ext = target.slice(target.lastIndexOf(".") + 1).toLowerCase()
    const mime: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
    }
    if (!mime[ext]) return null
    try {
      const maxDimension =
        typeof requestedMax === "number" && Number.isFinite(requestedMax)
          ? Math.max(32, Math.min(1024, Math.round(requestedMax)))
          : null
      if (maxDimension) {
        const image = nativeImage.createFromPath(target)
        if (image.isEmpty()) return null
        const size = image.getSize()
        const scale = Math.min(1, maxDimension / Math.max(size.width, size.height))
        const thumbnail = scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: "good",
            })
          : image
        return thumbnail.toDataURL()
      }
      const buf = await readFile(target)
      // A pasted screenshot is ~1-4MB; cap so a mis-attached huge file can't wedge
      // the renderer with a giant data URL.
      if (buf.length > 25 * 1024 * 1024) return null
      return `data:${mime[ext]};base64,${buf.toString("base64")}`
    } catch {
      return null
    }
  })

  ipcMain.handle(IpcChannels.listProjects, async () => {
    await ready
    return projects.list()
  })

  ipcMain.handle(IpcChannels.addProject, async (_e, cwd: unknown) => {
    await ready
    let folder: string | null =
      typeof cwd === "string" && cwd.trim() ? cwd.trim() : null
    if (!folder) {
      const win = BrowserWindow.getFocusedWindow() ?? focusedHubWindow()?.window ?? null
      const result = await dialog.showOpenDialog(win ?? undefined!, {
        properties: ["openDirectory", "createDirectory"],
        title: "Add project folder",
        buttonLabel: "Add project",
      })
      if (result.canceled || !result.filePaths[0]) return null
      folder = result.filePaths[0]
    }
    const project = await projects.add(assertExistingDir(folder))
    return { project, projects: projects.list() }
  })

  ipcMain.handle(
    IpcChannels.renameProject,
    async (_e, id: unknown, name: unknown) => {
      await ready
      if (typeof id !== "string" || !id) throw new Error("Invalid project id")
      if (typeof name !== "string") throw new Error("Invalid name")
      return projects.renameProject(id, name)
    },
  )

  ipcMain.handle(IpcChannels.removeProject, async (_e, id: unknown) => {
    await ready
    if (typeof id !== "string" || !id) throw new Error("Invalid project id")
    return projects.remove(id)
  })

  const envLookup = (serverId: string) => settings.getMcpEnv(serverId)

  async function mcpAfterMutate(cwd: string, cleanupNames: string[] = []) {
    const materialized = await materializeMcpForProject(
      cwd,
      envLookup,
      cleanupNames,
    )
    if (!materialized.ok) {
      throw new Error(materialized.error || "MCP materialize failed")
    }
    return mcpListForRenderer(cwd, settings, true)
  }

  ipcMain.handle(IpcChannels.mcpList, async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
    return mcpListForRenderer(cwd, settings, true)
  })

  ipcMain.handle(
    IpcChannels.mcpUpsert,
    async (_e, cwd: unknown, server: unknown) => {
      if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
      if (!server || typeof server !== "object") throw new Error("Invalid server")
      const def = server as McpServerDef
      const before = await readMcpConfig(cwd)
      const previous = before.servers.find((item) => item.id === def.id)
      await upsertMcpServer(cwd, def)
      const cleanupNames =
        previous && previous.name !== def.name ? [previous.name] : []
      return mcpAfterMutate(cwd, cleanupNames)
    },
  )

  ipcMain.handle(
    IpcChannels.mcpRemove,
    async (_e, cwd: unknown, id: unknown) => {
      if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
      if (typeof id !== "string" || !id) throw new Error("Invalid id")
      const before = await readMcpConfig(cwd)
      const previous = before.servers.find((item) => item.id === id)
      await removeMcpServer(cwd, id)
      const materialized = await materializeMcpForProject(
        cwd,
        envLookup,
        previous ? [previous.name] : [],
      )
      if (!materialized.ok) {
        throw new Error(materialized.error || "MCP materialize failed")
      }
      await settings.removeMcpServerEnv(id)
      return mcpListForRenderer(cwd, settings, true)
    },
  )

  ipcMain.handle(
    IpcChannels.mcpSetEnabled,
    async (_e, cwd: unknown, id: unknown, enabled: unknown) => {
      if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
      if (typeof id !== "string" || !id) throw new Error("Invalid id")
      if (typeof enabled !== "boolean") throw new Error("Invalid enabled")
      await setMcpServerEnabled(cwd, id, enabled)
      return mcpAfterMutate(cwd)
    },
  )

  ipcMain.handle(
    IpcChannels.mcpSetEnv,
    async (_e, serverId: unknown, envPatch: unknown) => {
      if (typeof serverId !== "string" || !serverId) {
        throw new Error("Invalid serverId")
      }
      if (!envPatch || typeof envPatch !== "object") {
        throw new Error("Invalid env patch")
      }
      return settings.setMcpServerEnv(
        serverId,
        envPatch as Record<string, string>,
      )
    },
  )

  ipcMain.handle(IpcChannels.mcpMaterialize, async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
    return materializeMcpForProject(cwd, envLookup)
  })

  ipcMain.handle(IpcChannels.mcpStatus, async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
    const config = await readMcpConfig(cwd)
    return probeMcpStatuses(config.servers)
  })

  ipcMain.handle(
    IpcChannels.mcpAddGitignore,
    async (_e, cwd: unknown, paths: unknown) => {
      if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
        throw new Error("Invalid paths")
      }
      return appendMcpPathsToGitignore(cwd, paths as string[])
    },
  )

  ipcMain.handle(IpcChannels.grokTrustStatus, async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
    return { trusted: await grokFolderTrusted(cwd), path: defaultGrokTrustPath() }
  })

  ipcMain.handle(IpcChannels.grokTrustFolder, async (_e, cwd: unknown) => {
    if (typeof cwd !== "string" || !cwd) throw new Error("Invalid cwd")
    return trustGrokFolder(cwd)
  })

  ipcMain.handle(IpcChannels.voiceAvailable, () => handyInstalled())

  ipcMain.handle(IpcChannels.voiceToggle, (_e, intent: unknown) => {
    if (intent !== "start" && intent !== "stop") {
      throw new Error("Invalid intent")
    }
    return toggleHandyTranscription(intent)
  })

  ipcMain.handle(IpcChannels.voiceCancel, () => cancelHandyTranscription())
}

/**
 * A dev run is a different app: its own userData, so it neither shares the
 * installed app's sessions and sealed keys nor trips the lock below — which
 * otherwise makes `pnpm dev` quit on sight whenever Chat Hub is installed.
 */
if (process.env.ELECTRON_RENDERER_URL) {
  app.setPath("userData", `${app.getPath("userData")}-dev`)
}

function focusHubWindow(): void {
  const hub = focusedHubWindow()
  if (hub) {
    showWindow(hub)
    return
  }
  if (settingsStore) openRememberedWindows()
}

export interface SingleInstanceHooks {
  /** Electron's lock — keyed on the userData path chosen just above. */
  requestLock: () => boolean
  quit: () => void
  onSecondInstance: (handler: () => void) => void
  /** Everything that touches the world: window, permission socket, stores. */
  boot: () => void
}

export type SingleInstanceOutcome = "boot" | "quit"

/**
 * One instance only. Two copies would fight over the same state.json, the same
 * bridge and — worst — the same permission socket: the second one unlinks the
 * first's `hub.sock` on boot, and every agent still blocked on an approval then
 * waits on a socket nobody is listening to.
 *
 * The decision lives in its own function because the thing worth asserting is
 * what a losing instance does *not* do: `boot` is the only path to a window, a
 * socket or a file, and it must stay untouched when the lock is already held.
 */
export function startSingleInstance(
  hooks: SingleInstanceHooks,
): SingleInstanceOutcome {
  if (!hooks.requestLock()) {
    hooks.quit()
    return "quit"
  }
  hooks.onSecondInstance(focusHubWindow)
  hooks.boot()
  return "boot"
}

export async function bootReadyChain(opts: {
  projects: ProjectStore
  sm: SessionManager
  usageLedger: UsageLedger
  startBroker: () => Promise<void>
}): Promise<void> {
  const { projects, sm, usageLedger } = opts
  await projects.load()
  // Before the first turn can spawn: dispatch() reads the socket path to point
  // the CLI's hook at us, so a broker that starts late loses that session's
  // approvals to the island.
  await opts.startBroker()
  await sm.init()
  await usageLedger.init(
    seedFromSessions(sm.listSessions(), sm.usageTotals()),
  )
  // Backfill: every existing session folder becomes a first-class project so it
  // stays pinned/manageable in the sidebar even after its sessions are gone.
  // Runs before ready resolves — the renderer's gated listProjects must never
  // race it, and it is disk-fast.
  for (const s of sm.listSessions()) {
    await projects.ensure(s.cwd, s.project)
  }
}

export function failBootstrap(err: unknown): void {
  console.error("[bootstrap] failed", err)
  dialog.showErrorBox(
    "Chat Hub failed to start",
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  )
  app.exit(1)
}

async function bootstrap(): Promise<void> {
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

  if (process.env.CHAT_HUB_SELFTEST === "1") {
    const { runProvidersSelfTest } = await import("./self-test")
    await runProvidersSelfTest()
  }

  const userData = app.getPath("userData")
  const bus = new EventBus()
  const persistence = new Persistence(Persistence.defaultPath(userData))
  const settings = new SettingsStore(SettingsStore.defaultPath(userData))
  await settings.load()
  settingsStore = settings
  const statusCache = new ProviderStatusCacheStore(
    ProviderStatusCacheStore.defaultPath(userData),
  )
  await statusCache.load()
  const providerStatuses = new ProviderStatusRefresher({
    probe: () => probeAllProviders(buildProbeInputs(settings)),
    configKey: () => JSON.stringify(buildProbeInputs(settings)),
    cache: statusCache,
    emit: (statuses, cachedAt) =>
      bus.emit({ type: "providers.statuses", statuses, cachedAt }),
  })
  const projects = new ProjectStore(ProjectStore.defaultPath(userData))
  const bridge = new SessionMonitorBridge(SessionMonitorBridge.defaultPath())
  const notifications = new NotificationService(
    (id) => manager?.getSession(id),
    () => settings.general.completionSound === true,
    focusSession,
  )
  const usageLedger = new UsageLedger(UsageLedger.defaultPath(userData))
  const sm = new SessionManager(
    bus,
    persistence,
    bridge,
    notifications,
    settings,
    undefined,
    { usageLedger },
  )
  manager = sm

  bus.on((event) => {
    if (event.type === "session.active") return
    sendToRenderer(IpcChannels.hubEvent, event)
  })

  const store = settings
  sm.setBrowserMcpRegistrar((session) =>
    registerBrowserMcp({
      provider: session.provider,
      root: session.cwd,
      execPath: process.execPath,
      scriptPath: browserMcpServerPath({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      }),
      socketPath: browserService.socketPath,
      sessionId: session.id,
      envFor: (serverId) => store.getMcpEnv(serverId),
    }),
  )

  const ready = bootReadyChain({
    projects,
    sm,
    usageLedger,
    startBroker: async () => {
      const broker = new PermissionBroker(bus, (agentSessionId, cwd) =>
        sm.findSessionForAgent(agentSessionId, cwd),
      )
      permissions = broker
      await broker.start()
      sm.setPermissionBroker(broker)
    },
  })

  registerIpc(
    sm,
    bridge,
    settings,
    projects,
    userData,
    usageLedger,
    providerStatuses,
    ready,
  )
  registerSurfaceIpc(terminals, (webContentsId) => {
    return hubForWebContents(webContentsId)?.id ?? null
  })
  registerBrowserIpc()
  registerMediaProtocol()
  registerWindowIpc()
  openRememberedWindows()
  bootMark("window.created")

  await ready
  bootMark("ready.resolved")

  dockBadge = wireDockBadge(bus, () => sm.listSessions())

  await browserService.start()

  commandBridge = new MonitorCommandBridge(sm, focusSession)
  commandBridge.start()

  app.on("activate", () => {
    if (windows.size === 0) openRememberedWindows()
    else focusHubWindow()
  })
}

let quitting = false

/**
 * Nothing here runs until the lock is ours — including the `whenReady`
 * registration, which would otherwise still fire in the instance that just
 * called quit() and give it a window and a socket on the way out.
 */
function boot(): void {
  // Privileged schemes are only registrable before "ready" — the media
  // protocol the Files surface streams video/audio through is one of them.
  registerMediaScheme()
  void app.whenReady().then(() => bootstrap().catch(failBootstrap))

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("before-quit", onBeforeQuit)
}

function onBeforeQuit(e: { preventDefault: () => void }): void {
  commandBridge?.stop()
  terminals.killAll()
  // Dropping the socket makes every waiting hook fail open rather than sit on a
  // decision that can no longer arrive.
  void permissions?.stop()
  permissions = null
  browserControl.detachAll()
  void browserService.stop()
  if (!manager || quitting) return
  quitting = true
  e.preventDefault()
  const sm = manager
  manager = null
  // A wedged child must not hold ⌘Q hostage: quit anyway once the kill+flush
  // has had a fair chance.
  const hardExit = setTimeout(() => app.exit(0), 3000)
  void sm.shutdown().finally(() => {
    clearTimeout(hardExit)
    app.exit(0)
  })
}

// Last line on purpose: by now every declaration the boot path reaches for
// exists, so the only work a losing instance does is ask for the lock and quit.
startSingleInstance({
  requestLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  onSecondInstance: (handler) => {
    app.on("second-instance", handler)
  },
  boot,
})
