import { act, createElement, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { BrowserSurface } from "../src/renderer/src/components/surfaces/BrowserSurface"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let guestReady: boolean
const openListeners = new Set<(session: string) => void>()
const bound = new Set<string>()
const attach = vi.fn(async (session: string) => { bound.add(session); return true })
const detach = vi.fn(async (session: string) => { bound.delete(session); return true })
const methods = {
  reload: () => {},
  getWebContentsId: () => {
    if (!guestReady) throw new Error("Guest not ready")
    return 123
  },
  getURL: () => "http://127.0.0.1:3301/login",
  canGoBack: () => false,
  canGoForward: () => false,
}

beforeEach(() => {
  bound.clear()
  openListeners.clear()
  attach.mockClear()
  detach.mockClear()
  guestReady = true
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(HTMLElement.prototype, name, { value, configurable: true })
  }
  Object.defineProperty(window, "chatHub", { configurable: true, value: {
    browserAttach: attach, browserDetach: detach, onBrowserActivity: () => () => {},
    onBrowserOpen: (callback: (session: string) => void) => {
      openListeners.add(callback)
      return () => openListeners.delete(callback)
    },
  } })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  for (const name of Object.keys(methods)) Reflect.deleteProperty(HTMLElement.prototype, name)
  Reflect.deleteProperty(window, "chatHub")
  document.body.replaceChildren()
})

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(StrictMode, null,
    createElement(BrowserSurface, { sessionId: "mary" }))))
  return host.querySelector("webview")!
}

it("reconnects an already loaded guest after effect cleanup without another dom-ready", async () => {
  await mount()
  // StrictMode replays setup/cleanup/setup while preserving the loaded DOM.
  expect(detach).toHaveBeenCalledWith("mary", 123)
  expect(bound.has("mary")).toBe(true)
  expect(attach).toHaveBeenLastCalledWith("mary", 123)
})

it("waits for dom-ready when a fresh webview has no guest yet", async () => {
  guestReady = false
  const view = await mount()
  expect(bound.has("mary")).toBe(false)
  guestReady = true
  await act(async () => { view.dispatchEvent(new Event("dom-ready")) })
  expect(bound.has("mary")).toBe(true)
})

it("restores a lost bridge when a tool requests the already open browser", async () => {
  await mount()
  bound.clear()
  await act(async () => { for (const callback of openListeners) callback("other") })
  expect(bound.has("mary")).toBe(false)
  await act(async () => { for (const callback of openListeners) callback("mary") })
  expect(bound.has("mary")).toBe(true)
})
