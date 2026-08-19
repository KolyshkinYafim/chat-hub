import { Buffer } from "node:buffer"
import { createRequire } from "node:module"
import {
  BROWSER_CONSOLE_BUFFER,
  BROWSER_NETWORK_BUFFER,
  BROWSER_OP_TIMEOUT_MS,
  BROWSER_SCREENSHOT_MAX_WIDTH,
  BROWSER_SNAPSHOT_CHAR_LIMIT,
  BROWSER_TEXT_CHAR_LIMIT,
  BROWSER_MODIFIERS,
  isBrowserRef,
  renderSnapshot,
  type BrowserActivity,
  type BrowserConsoleMessage,
  type BrowserModifier,
  type BrowserMouseButton,
  type BrowserNetworkEntry,
  type BrowserNode,
  type BrowserRequest,
  type BrowserResponse,
  type BrowserScrollDirection,
  type BrowserSnapshot,
} from "@shared/browser"
import { isAllowedGuestUrl } from "./browser"
import {
  fillScript,
  focusScript,
  rectScript,
  snapshotScript,
  textScript,
  viewportScript,
  waitForScript,
  type SnapshotFilter,
} from "./browser-page-script"

export const NO_GUEST_ERROR =
  "No browser surface is open for this session. Open the Browser surface in Chat Hub first."

export const SNAPSHOT_NODE_CAP = 800

const SETTLE_MS = 120
const SELECTOR_POLL_MS = 150
const DEFAULT_SELECTOR_TIMEOUT_MS = 5_000
const MAX_SELECTOR_TIMEOUT_MS = BROWSER_OP_TIMEOUT_MS - 2_000
const MAX_SLEEP_MS = 10_000
const DEFAULT_SCROLL_AMOUNT = 400
const MAX_SCROLL_AMOUNT = 20_000
const DEBUGGER_PROTOCOL_VERSION = "1.3"

export type GuestImage = {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number }): GuestImage
  toPNG(): Uint8Array
}

export type GuestDebugger = {
  isAttached(): boolean
  attach(version?: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

export type GuestInputEvent = Record<string, unknown>

/**
 * The structural slice of Electron's WebContents this module drives. Depending
 * on the shape rather than the class is what keeps the whole control surface
 * unit-testable with no Electron process behind it.
 */
export type GuestLike = {
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  sendInputEvent(event: GuestInputEvent): void
  insertText(text: string): Promise<void>
  capturePage(): Promise<GuestImage>
  goBack(): void
  goForward(): void
  reload(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  debugger?: GuestDebugger
  canGoBack?(): boolean
  canGoForward?(): boolean
}

export type BrowserControlOptions = {
  onActivity?: (activity: BrowserActivity) => void
  resolveGuest?: (webContentsId: number) => GuestLike | null
  settleMs?: number
  now?: () => number
}

type OpOutcome = {
  result: Record<string, unknown>
  summary: string
}

type Point = { x: number; y: number }

type Binding = {
  webContentsId: number
  console: BrowserConsoleMessage[]
  network: BrowserNetworkEntry[]
  networkIndex: Map<string, BrowserNetworkEntry>
  listeningTo: GuestLike | null
  consoleListener: ((...args: unknown[]) => void) | null
  debuggerListener: ((...args: unknown[]) => void) | null
  debuggerHost: GuestDebugger | null
}

const requireFromMain = createRequire(import.meta.url)

function resolveGuestViaElectron(webContentsId: number): GuestLike | null {
  const { webContents } = requireFromMain("electron") as typeof import("electron")
  const found = webContents.fromId(webContentsId)
  if (!found || found.isDestroyed()) return null
  return found as unknown as GuestLike
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string" && err) return err
  return "The browser surface failed for an unknown reason."
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The ${label} operation timed out after ${ms} ms.`))
    }, ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(errorMessage(err)))
      },
    )
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

export function normalizeModifiers(value: unknown): BrowserModifier[] {
  if (!Array.isArray(value)) return []
  const wanted = new Set<BrowserModifier>()
  for (const entry of value) {
    const name = String(entry).toLowerCase()
    const known = BROWSER_MODIFIERS.find((modifier) => modifier === name)
    if (known) wanted.add(known)
  }
  return [...wanted]
}

function normalizeButton(value: unknown): BrowserMouseButton {
  return value === "right" || value === "middle" ? value : "left"
}

function normalizeDirection(value: unknown): BrowserScrollDirection {
  return value === "up" || value === "left" || value === "right" ? value : "down"
}

function isPrintableKey(key: string): boolean {
  return key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) !== 127
}

export function consoleLevelFrom(value: unknown): BrowserConsoleMessage["level"] {
  if (typeof value === "number") {
    if (value <= 0) return "debug"
    if (value === 1) return "info"
    if (value === 2) return "warn"
    return "error"
  }
  const name = String(value ?? "").toLowerCase()
  if (name === "debug" || name === "verbose") return "debug"
  if (name === "info") return "info"
  if (name === "warn" || name === "warning") return "warn"
  if (name === "error") return "error"
  return "log"
}

/**
 * Electron changed the `console-message` payload from positional arguments to
 * a single event object, and a Hub build can meet either guest, so both shapes
 * are read here rather than at the call site.
 */
export function normalizeConsoleMessage(
  args: unknown[],
  at: number,
): BrowserConsoleMessage | null {
  const head = args[0]
  if (head && typeof head === "object" && "message" in head) {
    const event = head as {
      message?: unknown
      level?: unknown
      lineNumber?: unknown
      sourceId?: unknown
    }
    if (typeof event.message !== "string") return null
    return {
      level: consoleLevelFrom(event.level),
      text: event.message,
      source: typeof event.sourceId === "string" ? event.sourceId : "",
      line: typeof event.lineNumber === "number" ? event.lineNumber : 0,
      at,
    }
  }
  if (typeof args[2] !== "string") return null
  return {
    level: consoleLevelFrom(args[1]),
    text: args[2],
    source: typeof args[4] === "string" ? args[4] : "",
    line: typeof args[3] === "number" ? args[3] : 0,
    at,
  }
}

function pushCapped<T>(buffer: T[], entry: T, cap: number): void {
  buffer.push(entry)
  while (buffer.length > cap) buffer.shift()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

function asNode(value: unknown): BrowserNode | null {
  const raw = asRecord(value)
  if (typeof raw.ref !== "string" || typeof raw.role !== "string") return null
  const node: BrowserNode = {
    ref: raw.ref,
    role: raw.role,
    name: typeof raw.name === "string" ? raw.name : "",
    depth: typeof raw.depth === "number" ? raw.depth : 0,
  }
  if (typeof raw.value === "string") node.value = raw.value
  if (typeof raw.checked === "boolean") node.checked = raw.checked
  if (raw.disabled === true) node.disabled = true
  return node
}

export function toSnapshot(value: unknown, fallbackUrl: string): BrowserSnapshot {
  const raw = asRecord(value)
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map(asNode).filter((node): node is BrowserNode => node !== null)
    : []
  return {
    url: typeof raw.url === "string" ? raw.url : fallbackUrl,
    title: typeof raw.title === "string" ? raw.title : "",
    nodes,
    truncated: raw.truncated === true,
  }
}

/** Keeps a huge page from blowing the agent's context even under the node cap. */
export function fitSnapshotToCharLimit(
  snapshot: BrowserSnapshot,
  charLimit: number,
): BrowserSnapshot {
  if (renderSnapshot(snapshot).length <= charLimit) return snapshot
  let kept = snapshot.nodes.length
  while (kept > 0) {
    kept = Math.floor(kept * 0.8)
    const trimmed: BrowserSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.slice(0, kept),
      truncated: true,
    }
    if (renderSnapshot(trimmed).length <= charLimit) return trimmed
  }
  return { ...snapshot, nodes: [], truncated: true }
}

export class BrowserControl {
  private readonly bindings = new Map<string, Binding>()
  private readonly onActivity: (activity: BrowserActivity) => void
  private readonly resolveGuest: (webContentsId: number) => GuestLike | null
  private readonly settleMs: number
  private readonly now: () => number

  constructor(options: BrowserControlOptions = {}) {
    this.onActivity = options.onActivity ?? (() => {})
    this.resolveGuest = options.resolveGuest ?? resolveGuestViaElectron
    this.settleMs = options.settleMs ?? SETTLE_MS
    this.now = options.now ?? Date.now
  }

  attach(sessionId: string, webContentsId: number): void {
    if (!sessionId) return
    this.detach(sessionId)
    const binding: Binding = {
      webContentsId,
      console: [],
      network: [],
      networkIndex: new Map(),
      listeningTo: null,
      consoleListener: null,
      debuggerListener: null,
      debuggerHost: null,
    }
    this.bindings.set(sessionId, binding)
    const guest = this.liveGuest(binding)
    if (guest) this.startConsoleCapture(binding, guest)
  }

  detach(sessionId: string): void {
    const binding = this.bindings.get(sessionId)
    if (!binding) return
    this.bindings.delete(sessionId)
    this.stopConsoleCapture(binding)
    this.stopNetworkCapture(binding)
  }

  detachAll(): void {
    for (const sessionId of [...this.bindings.keys()]) this.detach(sessionId)
  }

  hasGuest(sessionId: string): boolean {
    const binding = this.bindings.get(sessionId)
    return binding ? this.liveGuest(binding) !== null : false
  }

  async handle(request: BrowserRequest): Promise<BrowserResponse> {
    const binding = this.bindings.get(request.sessionId) ?? null
    const guest = binding ? this.liveGuest(binding) : null
    if (!binding || !guest) {
      this.report(request, false, `${request.op} refused`, "")
      return { id: request.id, ok: false, error: NO_GUEST_ERROR }
    }
    if (binding.listeningTo !== guest) this.startConsoleCapture(binding, guest)

    try {
      const outcome = await withTimeout(
        this.run(request, binding, guest),
        BROWSER_OP_TIMEOUT_MS,
        request.op,
      )
      this.report(request, true, outcome.summary, this.safeUrl(guest))
      return { id: request.id, ok: true, result: outcome.result }
    } catch (err) {
      const message = errorMessage(err)
      this.report(request, false, message, this.safeUrl(guest))
      return { id: request.id, ok: false, error: message }
    }
  }

  private run(
    request: BrowserRequest,
    binding: Binding,
    guest: GuestLike,
  ): Promise<OpOutcome> {
    const params = request.params ?? {}
    switch (request.op) {
      case "navigate":
        return this.navigate(guest, params)
      case "snapshot":
        return this.snapshot(guest, params)
      case "click":
        return this.click(guest, params)
      case "type":
        return this.type(guest, params)
      case "fill":
        return this.fill(guest, params)
      case "key":
        return this.key(guest, params)
      case "scroll":
        return this.scroll(guest, params)
      case "hover":
        return this.hover(guest, params)
      case "screenshot":
        return this.screenshot(guest)
      case "text":
        return this.text(guest, params)
      case "console":
        return Promise.resolve(this.console(binding, params))
      case "network":
        return this.network(binding, guest, params)
      case "wait":
        return this.wait(guest, params)
      default:
        return Promise.reject(
          new Error(`Unknown browser operation ${JSON.stringify(request.op)}.`),
        )
    }
  }

  private async navigate(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    const target = params.url
    if (typeof target !== "string" || target === "") {
      throw new Error(
        'navigate needs a url, or one of "back", "forward", "reload".',
      )
    }
    if (target === "back") {
      if (guest.canGoBack && !guest.canGoBack()) {
        throw new Error("There is no page to go back to.")
      }
      await this.awaitLoad(guest, () => guest.goBack())
    } else if (target === "forward") {
      if (guest.canGoForward && !guest.canGoForward()) {
        throw new Error("There is no page to go forward to.")
      }
      await this.awaitLoad(guest, () => guest.goForward())
    } else if (target === "reload") {
      await this.awaitLoad(guest, () => guest.reload())
    } else {
      if (!isAllowedGuestUrl(target)) {
        throw new Error(
          `Refusing to open ${target}. The browser surface only allows http:, https: and about:blank.`,
        )
      }
      await this.awaitLoad(guest, () => {
        void Promise.resolve(guest.loadURL(target)).catch(() => {})
      })
    }
    const state = this.pageState(guest)
    return { result: state, summary: `${target} → ${state.url}` }
  }

  private awaitLoad(guest: GuestLike, start: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stop = (err: Error | null) => {
        guest.off("did-stop-loading", onStop)
        guest.off("did-fail-load", onFail)
        if (err) reject(err)
        else resolve()
      }
      const onStop = () => stop(null)
      const onFail = (...args: unknown[]) => {
        const isMainFrame = args[4] !== false
        const code = typeof args[1] === "number" ? args[1] : 0
        if (!isMainFrame || code === -3) return
        const description = typeof args[2] === "string" ? args[2] : "load failed"
        stop(new Error(`The page failed to load: ${description} (${code}).`))
      }
      guest.on("did-stop-loading", onStop)
      guest.on("did-fail-load", onFail)
      try {
        start()
      } catch (err) {
        stop(err instanceof Error ? err : new Error(errorMessage(err)))
      }
    })
  }

  private async snapshot(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    const filter: SnapshotFilter = params.filter === "all" ? "all" : "interactive"
    const limit = clampInt(params.limit, 1, SNAPSHOT_NODE_CAP, SNAPSHOT_NODE_CAP)
    const raw = await guest.executeJavaScript(snapshotScript({ filter, limit }))
    const snapshot = fitSnapshotToCharLimit(
      toSnapshot(raw, this.safeUrl(guest)),
      BROWSER_SNAPSHOT_CHAR_LIMIT,
    )
    return {
      result: snapshot as unknown as Record<string, unknown>,
      summary: `${filter} snapshot, ${snapshot.nodes.length} nodes`,
    }
  }

  private async click(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    const point = await this.pointFor(guest, params)
    const modifiers = normalizeModifiers(params.modifiers)
    const button = normalizeButton(params.button)
    const clickCount = params.doubleClick === true ? 2 : 1
    guest.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y, modifiers })
    guest.sendInputEvent({
      type: "mouseDown",
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers,
    })
    guest.sendInputEvent({
      type: "mouseUp",
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers,
    })
    await delay(this.settleMs)
    const target = isBrowserRef(params.ref)
      ? String(params.ref)
      : `(${point.x}, ${point.y})`
    return {
      result: this.pageState(guest),
      summary: `${clickCount === 2 ? "double click" : "click"} ${target}`,
    }
  }

  private async type(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    const text = params.text
    if (typeof text !== "string" || text === "") {
      throw new Error("type needs a non-empty text.")
    }
    if (params.ref !== undefined) {
      const ref = this.requireRef(params.ref)
      const focused = asRecord(
        await guest.executeJavaScript(focusScript(ref)),
      )
      if (focused.ok !== true) {
        throw new Error(`Could not focus ${ref}. Take a fresh snapshot.`)
      }
    }
    await guest.insertText(text)
    if (params.submit === true) this.sendKey(guest, "Enter", [])
    return {
      result: {},
      summary: `type ${text.length} chars${params.submit === true ? " and submit" : ""}`,
    }
  }

  private async fill(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    const ref = this.requireRef(params.ref)
    const value = params.value
    if (typeof value !== "string") throw new Error("fill needs a string value.")
    const outcome = asRecord(await guest.executeJavaScript(fillScript(ref, value)))
    if (outcome.ok !== true) {
      throw new Error(
        `Could not fill ${ref}: it is not an input, select or editable element.`,
      )
    }
    const kind = typeof outcome.kind === "string" ? outcome.kind : "unknown"
    return { result: { kind }, summary: `fill ${ref} (${kind})` }
  }

  private async key(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    const key = params.key
    if (typeof key !== "string" || key === "") {
      throw new Error('key needs a key name such as "Enter" or "Escape".')
    }
    this.sendKey(guest, key, normalizeModifiers(params.modifiers))
    await delay(this.settleMs)
    return { result: {}, summary: `key ${key}` }
  }

  private async scroll(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    const direction = normalizeDirection(params.direction)
    const amount = clampInt(
      params.amount,
      1,
      MAX_SCROLL_AMOUNT,
      DEFAULT_SCROLL_AMOUNT,
    )
    const point = await this.pointFor(guest, params, true)
    const deltaY = direction === "down" ? -amount : direction === "up" ? amount : 0
    const deltaX = direction === "right" ? -amount : direction === "left" ? amount : 0
    guest.sendInputEvent({
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX,
      deltaY,
      canScroll: true,
    })
    await delay(this.settleMs)
    return { result: {}, summary: `scroll ${direction} ${amount}` }
  }

  private async hover(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    const point = await this.pointFor(guest, params)
    guest.sendInputEvent({
      type: "mouseMove",
      x: point.x,
      y: point.y,
      modifiers: normalizeModifiers(params.modifiers),
    })
    await delay(this.settleMs)
    const target = isBrowserRef(params.ref)
      ? String(params.ref)
      : `(${point.x}, ${point.y})`
    return { result: {}, summary: `hover ${target}` }
  }

  private async screenshot(guest: GuestLike): Promise<OpOutcome> {
    const captured = await guest.capturePage()
    if (!captured || captured.isEmpty()) {
      throw new Error("The page produced an empty screenshot.")
    }
    const size = captured.getSize()
    const image =
      size.width > BROWSER_SCREENSHOT_MAX_WIDTH
        ? captured.resize({ width: BROWSER_SCREENSHOT_MAX_WIDTH })
        : captured
    const finalSize = image.getSize()
    const base64 = Buffer.from(image.toPNG()).toString("base64")
    return {
      result: {
        dataUrl: `data:image/png;base64,${base64}`,
        width: finalSize.width,
        height: finalSize.height,
      },
      summary: `screenshot ${finalSize.width}×${finalSize.height}`,
    }
  }

  private async text(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    const limit = clampInt(
      params.limit,
      1,
      BROWSER_TEXT_CHAR_LIMIT,
      BROWSER_TEXT_CHAR_LIMIT,
    )
    const raw = asRecord(await guest.executeJavaScript(textScript(limit)))
    const text = typeof raw.text === "string" ? raw.text.slice(0, limit) : ""
    return {
      result: { text, truncated: raw.truncated === true },
      summary: `read ${text.length} chars of text`,
    }
  }

  private console(
    binding: Binding,
    params: Record<string, unknown>,
  ): OpOutcome {
    const onlyErrors = params.onlyErrors === true
    const limit = clampInt(
      params.limit,
      1,
      BROWSER_CONSOLE_BUFFER,
      BROWSER_CONSOLE_BUFFER,
    )
    const matching = onlyErrors
      ? binding.console.filter((entry) => entry.level === "error")
      : binding.console
    const messages = matching.slice(-limit)
    return {
      result: { messages },
      summary: `console, ${messages.length} messages`,
    }
  }

  private async network(
    binding: Binding,
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    this.startNetworkCapture(binding, guest)
    const pattern =
      typeof params.urlPattern === "string" && params.urlPattern !== ""
        ? params.urlPattern
        : null
    const limit = clampInt(
      params.limit,
      1,
      BROWSER_NETWORK_BUFFER,
      BROWSER_NETWORK_BUFFER,
    )
    const matching = pattern
      ? binding.network.filter((entry) => entry.url.includes(pattern))
      : binding.network
    const requests = matching.slice(-limit)
    return {
      result: { requests },
      summary: `network, ${requests.length} requests`,
    }
  }

  private async wait(
    guest: GuestLike,
    params: Record<string, unknown>,
  ): Promise<OpOutcome> {
    if (typeof params.selector === "string" && params.selector !== "") {
      const selector = params.selector
      const timeoutMs = clampInt(
        params.timeoutMs,
        0,
        MAX_SELECTOR_TIMEOUT_MS,
        DEFAULT_SELECTOR_TIMEOUT_MS,
      )
      const deadline = this.now() + timeoutMs
      const script = waitForScript(selector)
      for (;;) {
        if ((await guest.executeJavaScript(script)) === true) {
          return {
            result: { matched: true, selector },
            summary: `waited for ${selector}`,
          }
        }
        if (this.now() >= deadline) {
          return {
            result: { matched: false, selector },
            summary: `gave up waiting for ${selector}`,
          }
        }
        await delay(SELECTOR_POLL_MS)
      }
    }
    const ms = clampInt(params.ms, 0, MAX_SLEEP_MS, 0)
    await delay(ms)
    return { result: { waitedMs: ms }, summary: `waited ${ms} ms` }
  }

  private sendKey(
    guest: GuestLike,
    key: string,
    modifiers: BrowserModifier[],
  ): void {
    guest.sendInputEvent({ type: "keyDown", keyCode: key, modifiers })
    if (isPrintableKey(key)) {
      guest.sendInputEvent({ type: "char", keyCode: key, modifiers })
    }
    guest.sendInputEvent({ type: "keyUp", keyCode: key, modifiers })
  }

  private requireRef(value: unknown): string {
    if (!isBrowserRef(value)) {
      throw new Error(
        `${JSON.stringify(value)} is not an element ref. Take a snapshot and use a ref_N from it.`,
      )
    }
    return value
  }

  private async pointFor(
    guest: GuestLike,
    params: Record<string, unknown>,
    allowViewportCentre = false,
  ): Promise<Point> {
    if (params.ref !== undefined) {
      const ref = this.requireRef(params.ref)
      const rect = asRecord(await guest.executeJavaScript(rectScript(ref)))
      if (typeof rect.x !== "number" || typeof rect.y !== "number") {
        throw new Error(`${ref} is no longer on the page. Take a fresh snapshot.`)
      }
      const width = typeof rect.width === "number" ? rect.width : 0
      const height = typeof rect.height === "number" ? rect.height : 0
      return {
        x: Math.round(rect.x + width / 2),
        y: Math.round(rect.y + height / 2),
      }
    }
    if (typeof params.x === "number" && typeof params.y === "number") {
      return { x: Math.round(params.x), y: Math.round(params.y) }
    }
    if (!allowViewportCentre) {
      throw new Error("Point at an element with ref, or give x and y.")
    }
    const viewport = asRecord(await guest.executeJavaScript(viewportScript()))
    const width = typeof viewport.width === "number" ? viewport.width : 2
    const height = typeof viewport.height === "number" ? viewport.height : 2
    return { x: Math.round(width / 2), y: Math.round(height / 2) }
  }

  private pageState(guest: GuestLike): { url: string; title: string } {
    return { url: this.safeUrl(guest), title: this.safeTitle(guest) }
  }

  private safeUrl(guest: GuestLike): string {
    try {
      return guest.getURL()
    } catch {
      return ""
    }
  }

  private safeTitle(guest: GuestLike): string {
    try {
      return guest.getTitle()
    } catch {
      return ""
    }
  }

  private liveGuest(binding: Binding): GuestLike | null {
    let guest: GuestLike | null
    try {
      guest = this.resolveGuest(binding.webContentsId)
    } catch {
      return null
    }
    if (!guest) return null
    try {
      if (guest.isDestroyed()) return null
    } catch {
      return null
    }
    return guest
  }

  private startConsoleCapture(binding: Binding, guest: GuestLike): void {
    this.stopConsoleCapture(binding)
    const listener = (...args: unknown[]) => {
      const message = normalizeConsoleMessage(args, this.now())
      if (message) pushCapped(binding.console, message, BROWSER_CONSOLE_BUFFER)
    }
    binding.consoleListener = listener
    binding.listeningTo = guest
    guest.on("console-message", listener)
  }

  private stopConsoleCapture(binding: Binding): void {
    if (binding.listeningTo && binding.consoleListener) {
      try {
        binding.listeningTo.off("console-message", binding.consoleListener)
      } catch {
        /* the guest went away before we could unsubscribe */
      }
    }
    binding.consoleListener = null
    binding.listeningTo = null
  }

  private startNetworkCapture(binding: Binding, guest: GuestLike): void {
    if (binding.debuggerHost) return
    const host = guest.debugger
    if (!host) {
      throw new Error(
        "This browser surface cannot record network traffic: the guest exposes no debugger.",
      )
    }
    try {
      if (!host.isAttached()) host.attach(DEBUGGER_PROTOCOL_VERSION)
    } catch (err) {
      throw new Error(
        `Could not record network traffic: ${errorMessage(err)}. Close any other debugger attached to this page (DevTools counts) and try again.`,
        { cause: err },
      )
    }
    const listener = (...args: unknown[]) => {
      this.recordNetworkEvent(binding, args)
    }
    binding.debuggerListener = listener
    binding.debuggerHost = host
    host.on("message", listener)
    void Promise.resolve(host.sendCommand("Network.enable")).catch(() => {})
  }

  private stopNetworkCapture(binding: Binding): void {
    const host = binding.debuggerHost
    binding.debuggerHost = null
    if (!host) return
    if (binding.debuggerListener) {
      try {
        host.off("message", binding.debuggerListener)
      } catch {
        /* the guest went away before we could unsubscribe */
      }
    }
    binding.debuggerListener = null
    try {
      if (host.isAttached()) host.detach()
    } catch {
      /* already gone */
    }
  }

  private recordNetworkEvent(binding: Binding, args: unknown[]): void {
    const method = args.find((arg) => typeof arg === "string")
    const payload = asRecord(
      args.find((arg, index) => index > 0 && arg && typeof arg === "object"),
    )
    const requestId =
      typeof payload.requestId === "string" ? payload.requestId : null
    if (!requestId) return

    if (method === "Network.requestWillBeSent") {
      const request = asRecord(payload.request)
      const entry: BrowserNetworkEntry = {
        requestId,
        method: typeof request.method === "string" ? request.method : "GET",
        url: typeof request.url === "string" ? request.url : "",
        status: null,
        mimeType: null,
        failed: false,
        at: this.now(),
      }
      const evicted =
        binding.network.length >= BROWSER_NETWORK_BUFFER
          ? binding.network[0]
          : null
      pushCapped(binding.network, entry, BROWSER_NETWORK_BUFFER)
      if (evicted) binding.networkIndex.delete(evicted.requestId)
      binding.networkIndex.set(requestId, entry)
      return
    }

    const known = binding.networkIndex.get(requestId)
    if (!known) return
    if (method === "Network.responseReceived") {
      const response = asRecord(payload.response)
      known.status = typeof response.status === "number" ? response.status : null
      known.mimeType =
        typeof response.mimeType === "string" ? response.mimeType : null
      return
    }
    if (method === "Network.loadingFailed") known.failed = true
  }

  private report(
    request: BrowserRequest,
    ok: boolean,
    summary: string,
    url: string,
  ): void {
    try {
      this.onActivity({
        sessionId: request.sessionId,
        op: request.op,
        summary,
        url,
        at: this.now(),
        ok,
      })
    } catch {
      /* a broken renderer bridge must not fail the op */
    }
  }
}
