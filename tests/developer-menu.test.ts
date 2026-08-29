import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  BrowserWindow,
  MenuItemConstructorOptions,
  WebContents,
} from "electron"

const electron = vi.hoisted(() => ({
  applicationTemplate: null as MenuItemConstructorOptions[] | null,
  popupTemplates: [] as MenuItemConstructorOptions[][],
  revealed: [] as string[],
  logsPath: "",
}))

vi.mock("electron", () => ({
  app: {
    name: "Chat Hub",
    getPath: () => electron.logsPath,
  },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => ({
      template,
      popup: () => electron.popupTemplates.push(template),
    }),
    setApplicationMenu: (menu: { template: MenuItemConstructorOptions[] }) => {
      electron.applicationTemplate = menu.template
    },
  },
  shell: {
    showItemInFolder: (path: string) => electron.revealed.push(path),
  },
}))

const { buildDeveloperMenuTemplate, installDeveloperMenu } = await import(
  "../src/main/developer-menu"
)
const { createMainLog, redactSensitive } = await import("../src/main/main-log")

type EventHandler = (...args: unknown[]) => void

function fakeContents() {
  const handlers = new Map<string, EventHandler[]>()
  const contents = {
    destroyed: false,
    isDestroyed: vi.fn(() => contents.destroyed),
    toggleDevTools: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    inspectElement: vi.fn(),
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return contents
    }),
  }
  return {
    contents: contents as unknown as WebContents,
    raw: contents,
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler({}, ...args)
    },
  }
}

function fakeWindow(contents: WebContents) {
  const window = {
    destroyed: false,
    isDestroyed: vi.fn(() => window.destroyed),
    webContents: contents,
  }
  return window as unknown as BrowserWindow & { destroyed: boolean }
}

function submenu(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const item = template.find((entry) => entry.label === label)
  if (!item || !Array.isArray(item.submenu)) throw new Error(`Missing ${label}`)
  return item.submenu
}

function item(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions {
  const found = template.find((entry) => entry.label === label)
  if (!found) throw new Error(`Missing ${label}`)
  return found
}

function click(entry: MenuItemConstructorOptions): void {
  if (typeof entry.click !== "function") throw new Error("Menu item is not clickable")
  entry.click({} as never, undefined, {} as never)
}

beforeEach(() => {
  electron.applicationTemplate = null
  electron.popupTemplates = []
  electron.revealed = []
  electron.logsPath = mkdtempSync(join(tmpdir(), "chat-hub-developer-"))
})

describe("File menu", () => {
  it("offers New Window on ⌘⇧N and still closes the window", () => {
    const host = fakeContents()
    const window = fakeWindow(host.contents)
    const log = createMainLog(join(electron.logsPath, "menu.log"))
    const opened: string[] = []
    const file = submenu(
      buildDeveloperMenuTemplate(() => window, log, undefined, () =>
        opened.push("new"),
      ),
      "File",
    )

    const newWindow = item(file, "New Window")
    expect(newWindow.accelerator).toBe("CommandOrControl+Shift+N")
    click(newWindow)
    expect(opened).toEqual(["new"])
    // Close stays: it closes the window, and the app lives on without it.
    expect(file.some((entry) => entry.role === "close")).toBe(true)
  })

  it("leaves the File menu as it was when no opener is supplied", () => {
    const host = fakeContents()
    const window = fakeWindow(host.contents)
    const log = createMainLog(join(electron.logsPath, "menu.log"))
    const file = submenu(buildDeveloperMenuTemplate(() => window, log), "File")
    expect(file).toHaveLength(1)
    expect(file[0]?.role).toBe("close")
  })
})

describe("Developer menu", () => {
  it("declares the required actions and native shortcuts", () => {
    const host = fakeContents()
    const window = fakeWindow(host.contents)
    const log = createMainLog(join(electron.logsPath, "menu.log"))
    const developer = submenu(
      buildDeveloperMenuTemplate(() => window, log),
      "Developer",
    )

    expect(item(developer, "Toggle DevTools").accelerator).toBe(
      "CommandOrControl+Alt+I",
    )
    expect(item(developer, "Reload").accelerator).toBe("CommandOrControl+R")
    expect(item(developer, "Force Reload").accelerator).toBe(
      "CommandOrControl+Shift+R",
    )
    expect(item(developer, "Reveal Main Log")).toBeDefined()
  })

  it("carries the native zoom accelerators without shadowing the existing ones", () => {
    const host = fakeContents()
    const window = fakeWindow(host.contents)
    const log = createMainLog(join(electron.logsPath, "menu.log"))
    const calls: string[] = []
    const template = buildDeveloperMenuTemplate(() => window, log, {
      zoomIn: () => calls.push("in"),
      zoomOut: () => calls.push("out"),
      reset: () => calls.push("reset"),
    })
    const view = submenu(template, "View")
    const accelerators = view.map((entry) => entry.accelerator)

    expect(accelerators).toEqual([
      "CommandOrControl+0",
      "CommandOrControl+Plus",
      // ⌘+ is Shift+= on most layouts, so the bare `=` is the live binding.
      "CommandOrControl+=",
      "CommandOrControl+-",
    ])
    const developer = submenu(template, "Developer")
    const taken = new Set(
      developer.map((entry) => entry.accelerator).filter(Boolean),
    )
    for (const accelerator of accelerators) {
      expect(taken.has(accelerator)).toBe(false)
    }

    click(item(view, "Actual Size"))
    click(view.filter((entry) => entry.label === "Zoom In")[0])
    click(view.filter((entry) => entry.label === "Zoom In")[1])
    click(item(view, "Zoom Out"))
    expect(calls).toEqual(["reset", "in", "in", "out"])
  })

  it("leaves the menu bar unchanged when no zoom controller is supplied", () => {
    const host = fakeContents()
    const window = fakeWindow(host.contents)
    const log = createMainLog(join(electron.logsPath, "menu.log"))
    const template = buildDeveloperMenuTemplate(() => window, log)
    expect(template.find((entry) => entry.label === "View")).toBeUndefined()
  })

  it("targets only the installed live window and safely no-ops once destroyed", () => {
    const host = fakeContents()
    const window = fakeWindow(host.contents)
    const log = createMainLog(join(electron.logsPath, "menu.log"))
    let currentWindow: BrowserWindow | null = window
    const developer = submenu(
      buildDeveloperMenuTemplate(() => currentWindow, log),
      "Developer",
    )

    click(item(developer, "Toggle DevTools"))
    click(item(developer, "Reload"))
    click(item(developer, "Force Reload"))
    expect(host.raw.toggleDevTools).toHaveBeenCalledOnce()
    expect(host.raw.reload).toHaveBeenCalledOnce()
    expect(host.raw.reloadIgnoringCache).toHaveBeenCalledOnce()

    currentWindow = null
    click(item(developer, "Toggle DevTools"))
    click(item(developer, "Reload"))
    click(item(developer, "Force Reload"))
    expect(host.raw.toggleDevTools).toHaveBeenCalledOnce()
    expect(host.raw.reload).toHaveBeenCalledOnce()
    expect(host.raw.reloadIgnoringCache).toHaveBeenCalledOnce()

    currentWindow = window
    window.destroyed = true
    click(item(developer, "Reload"))
    expect(host.raw.reload).toHaveBeenCalledOnce()
  })

  it("reveals the concrete log and inspects renderer and guest coordinates", () => {
    const host = fakeContents()
    const guest = fakeContents()
    const window = fakeWindow(host.contents)
    const logPath = join(electron.logsPath, "main.log")

    installDeveloperMenu(() => window, { logPath })
    expect(electron.applicationTemplate).not.toBeNull()
    const developer = submenu(electron.applicationTemplate!, "Developer")
    click(item(developer, "Reveal Main Log"))
    expect(electron.revealed).toEqual([logPath])

    host.emit("context-menu", { x: 17, y: 29 })
    click(item(electron.popupTemplates.at(-1)!, "Inspect Element"))
    expect(host.raw.inspectElement).toHaveBeenCalledWith(17, 29)

    host.emit("did-attach-webview", guest.contents)
    guest.emit("context-menu", { x: 31, y: 47 })
    click(item(electron.popupTemplates.at(-1)!, "Inspect Element"))
    expect(guest.raw.inspectElement).toHaveBeenCalledWith(31, 47)

    guest.raw.destroyed = true
    click(item(electron.popupTemplates.at(-1)!, "Inspect Element"))
    expect(guest.raw.inspectElement).toHaveBeenCalledOnce()
  })
})

describe("main log", () => {
  it("redacts common secret forms", () => {
    const text = redactSensitive(
      "Bearer abc token=one password:two https://x.test/?api_key=three",
    )
    expect(text).not.toContain("abc")
    expect(text).not.toContain("one")
    expect(text).not.toContain("two")
    expect(text).not.toContain("three")
    expect(text.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it("creates a private file and rotates to one bounded backup", () => {
    const path = join(electron.logsPath, "rotating.log")
    let tick = 0
    const log = createMainLog(path, {
      maxBytes: 100,
      now: () => new Date(Date.UTC(2026, 7, 4, 0, 0, tick++)),
    })

    for (let i = 0; i < 8; i += 1) log.write("developer.reload")

    expect(readFileSync(path, "utf8")).toContain("developer.reload")
    expect(readFileSync(`${path}.1`, "utf8")).toContain("developer.reload")
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600)
  })
})
