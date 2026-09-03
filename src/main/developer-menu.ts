import {
  app,
  Menu,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron"
import { join } from "node:path"
import { createMainLog, type MainLog, type MainLogEvent } from "./main-log"

const attachedInspectMenus = new WeakSet<WebContents>()
let mainLog: MainLog | null = null
type WindowProvider = () => BrowserWindow | null

function usable(contents: WebContents | null | undefined): contents is WebContents {
  return Boolean(contents && !contents.isDestroyed())
}

function windowContents(window: BrowserWindow | null): WebContents | null {
  if (!window) return null
  if (window.isDestroyed()) return null
  return usable(window.webContents) ? window.webContents : null
}

function withWindowContents(
  getWindow: WindowProvider,
  log: MainLog,
  event: MainLogEvent,
  action: (contents: WebContents) => void,
): void {
  const contents = windowContents(getWindow())
  if (!contents) return
  action(contents)
  log.write(event)
}

function inspectMenu(
  contents: WebContents,
  kind: "renderer" | "guest",
  log: MainLog,
  x: number,
  y: number,
): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "Inspect Element",
      click: () => {
        if (!usable(contents)) return
        contents.inspectElement(x, y)
        log.write(
          kind === "renderer"
            ? "developer.inspect-renderer"
            : "developer.inspect-guest",
        )
      },
    },
  ])
  menu.popup()
}

function attachContextInspect(
  contents: WebContents,
  kind: "renderer" | "guest",
  log: MainLog,
): void {
  if (attachedInspectMenus.has(contents)) return
  attachedInspectMenus.add(contents)
  contents.on("context-menu", (_event, params) => {
    if (!usable(contents)) return
    inspectMenu(contents, kind, log, params.x, params.y)
  })
}

/** The three shell-zoom actions the View menu drives. */
export type ZoomActions = {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
}

/**
 * ⌘+ is Shift+= on most layouts, so the plain-`=` binding is the one that
 * actually fires; the visible item carries the glyph users expect to read.
 */
function viewMenu(zoom: ZoomActions): MenuItemConstructorOptions {
  return {
    label: "View",
    submenu: [
      {
        label: "Actual Size",
        accelerator: "CommandOrControl+0",
        click: zoom.reset,
      },
      {
        label: "Zoom In",
        accelerator: "CommandOrControl+Plus",
        click: zoom.zoomIn,
      },
      {
        label: "Zoom In",
        accelerator: "CommandOrControl+=",
        visible: false,
        acceleratorWorksWhenHidden: true,
        click: zoom.zoomIn,
      },
      {
        label: "Zoom Out",
        accelerator: "CommandOrControl+-",
        click: zoom.zoomOut,
      },
    ],
  }
}

export function buildDeveloperMenuTemplate(
  getWindow: WindowProvider,
  log: MainLog,
  zoom?: ZoomActions,
  newWindow?: () => void,
): MenuItemConstructorOptions[] {
  const developer: MenuItemConstructorOptions = {
    label: "Developer",
    submenu: [
      {
        label: "Toggle DevTools",
        accelerator: "CommandOrControl+Alt+I",
        click: () =>
          withWindowContents(
            getWindow,
            log,
            "developer.toggle-devtools",
            (contents) => contents.toggleDevTools(),
          ),
      },
      { type: "separator" },
      {
        label: "Reload",
        accelerator: "CommandOrControl+R",
        click: () =>
          withWindowContents(getWindow, log, "developer.reload", (contents) =>
            contents.reload(),
          ),
      },
      {
        label: "Force Reload",
        accelerator: "CommandOrControl+Shift+R",
        click: () =>
          withWindowContents(
            getWindow,
            log,
            "developer.force-reload",
            (contents) => contents.reloadIgnoringCache(),
          ),
      },
      { type: "separator" },
      {
        label: "Reveal Main Log",
        click: () => {
          shell.showItemInFolder(log.path)
          log.write("developer.reveal-main-log")
        },
      },
    ],
  }

  const fileMenu: MenuItemConstructorOptions[] = [
    ...(newWindow
      ? [
          {
            label: "New Window",
            accelerator: "CommandOrControl+Shift+N",
            click: newWindow,
          } satisfies MenuItemConstructorOptions,
          { type: "separator" } satisfies MenuItemConstructorOptions,
        ]
      : []),
    { role: "close" },
  ]

  const common: MenuItemConstructorOptions[] = [
    { label: "File", submenu: fileMenu },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    ...(zoom ? [viewMenu(zoom)] : []),
    developer,
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
    },
  ]

  if (process.platform !== "darwin") return common
  return [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    ...common,
  ]
}

export type DeveloperMenuOptions = {
  logPath?: string
  /** Omitted in tests; production always supplies the persisted controller. */
  zoom?: ZoomActions
  newWindow?: () => void
}

/** Install the native menu and context Inspect action for one Hub window. */
export function installDeveloperMenu(
  getWindow: WindowProvider,
  options: DeveloperMenuOptions = {},
): MainLog {
  const logPath = options.logPath ?? join(app.getPath("logs"), "main.log")
  if (!mainLog || mainLog.path !== logPath) mainLog = createMainLog(logPath)
  const log = mainLog

  const window = getWindow()
  const contents = windowContents(window)
  if (contents) {
    attachContextInspect(contents, "renderer", log)
    contents.on("did-attach-webview", (_event, guest) => {
      if (!usable(guest)) return
      attachContextInspect(guest, "guest", log)
    })
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildDeveloperMenuTemplate(
        getWindow,
        log,
        options.zoom,
        options.newWindow,
      ),
    ),
  )
  log.write("developer.menu-installed")
  return log
}
