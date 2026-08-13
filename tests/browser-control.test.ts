import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  BROWSER_CONSOLE_BUFFER,
  BROWSER_OP_TIMEOUT_MS,
  BROWSER_SCREENSHOT_MAX_WIDTH,
  type BrowserActivity,
  type BrowserOp,
  type BrowserResponse,
  type BrowserSnapshot,
} from "../src/shared/browser"
import {
  BrowserControl,
  NO_GUEST_ERROR,
  type GuestDebugger,
  type GuestImage,
  type GuestInputEvent,
  type GuestLike,
} from "../src/main/surfaces/browser-control"

type Listener = (...args: unknown[]) => void

type FakeDebugger = GuestDebugger & {
  attached: boolean
  commands: string[]
  emit(...args: unknown[]): void
}

type FakeGuest = GuestLike & {
  destroyed: boolean
  url: string
  title: string
  input: GuestInputEvent[]
  inserted: string[]
  evaluated: string[]
  emit(event: string, ...args: unknown[]): void
  queueScriptResults(...values: unknown[]): void
  debugger: FakeDebugger
}

const SESSION = "session-1"
const GUEST_ID = 42

function createImage(width: number, height: number): GuestImage {
  const image: GuestImage = {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: ({ width: next }) =>
      createImage(next ?? width, Math.round((height * (next ?? width)) / width)),
    toPNG: () => new Uint8Array([137, 80, 78, 71]),
  }
  return image
}

function createDebugger(): FakeDebugger {
  const listeners = new Set<Listener>()
  const host: FakeDebugger = {
    attached: false,
    commands: [],
    isAttached: () => host.attached,
    attach: () => {
      host.attached = true
    },
    detach: () => {
      host.attached = false
    },
    sendCommand: async (method) => {
      host.commands.push(method)
      return {}
    },
    on: (_event, listener) => listeners.add(listener as Listener),
    off: (_event, listener) => listeners.delete(listener as Listener),
    emit: (...args) => {
      for (const listener of [...listeners]) listener(...args)
    },
  }
  return host
}

function createGuest(): FakeGuest {
  const listeners = new Map<string, Set<Listener>>()
  const scriptResults: unknown[] = []
  const guest: FakeGuest = {
    destroyed: false,
    url: "https://example.com/start",
    title: "Start",
    input: [],
    inserted: [],
    evaluated: [],
    debugger: createDebugger(),
    isDestroyed: () => guest.destroyed,
    loadURL: async (url) => {
      guest.url = url
    },
    getURL: () => guest.url,
    getTitle: () => guest.title,
    executeJavaScript: async (code) => {
      guest.evaluated.push(code)
      return scriptResults.length > 0 ? scriptResults.shift() : null
    },
    sendInputEvent: (event) => {
      guest.input.push(event)
    },
    insertText: async (text) => {
      guest.inserted.push(text)
    },
    capturePage: async () => createImage(800, 600),
    goBack: () => {},
    goForward: () => {},
    reload: () => {},
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(event, set)
      return guest
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener)
      return guest
    },
    emit: (event, ...args) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    queueScriptResults: (...values) => {
      scriptResults.push(...values)
    },
  }
  return guest
}

let guest: FakeGuest
let activity: BrowserActivity[]
let control: BrowserControl

function makeControl(resolve?: (id: number) => GuestLike | null): BrowserControl {
  return new BrowserControl({
    settleMs: 0,
    onActivity: (entry) => activity.push(entry),
    resolveGuest: resolve ?? ((id) => (id === GUEST_ID ? guest : null)),
  })
}

function send(
  op: BrowserOp,
  params: Record<string, unknown> = {},
  sessionId = SESSION,
): Promise<BrowserResponse> {
  return control.handle({ id: `req-${op}`, sessionId, op, params })
}

function resultOf(response: BrowserResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`expected success, got ${response.error}`)
  return response.result
}

beforeEach(() => {
  guest = createGuest()
  activity = []
  control = makeControl()
})

afterEach(() => {
  control.detachAll()
  vi.useRealTimers()
})

describe("guest registry", () => {
  it("refuses an op with an actionable error when no surface is attached", async () => {
    const response = await send("snapshot")

    expect(response).toEqual({ id: "req-snapshot", ok: false, error: NO_GUEST_ERROR })
    expect(guest.evaluated).toEqual([])
  })

  it("treats a destroyed guest as absent", async () => {
    control.attach(SESSION, GUEST_ID)
    guest.destroyed = true

    expect(control.hasGuest(SESSION)).toBe(false)
    expect(await send("screenshot")).toMatchObject({ ok: false, error: NO_GUEST_ERROR })
  })

  it("knows which sessions have a live guest", () => {
    expect(control.hasGuest(SESSION)).toBe(false)

    control.attach(SESSION, GUEST_ID)

    expect(control.hasGuest(SESSION)).toBe(true)
    expect(control.hasGuest("other")).toBe(false)
  })

  it("stops driving a guest after detach", async () => {
    control.attach(SESSION, GUEST_ID)
    guest.queueScriptResults({ url: "https://example.com/", title: "T", nodes: [], truncated: false })
    expect(await send("snapshot")).toMatchObject({ ok: true })

    control.detach(SESSION)

    expect(control.hasGuest(SESSION)).toBe(false)
    expect(await send("snapshot")).toMatchObject({ ok: false, error: NO_GUEST_ERROR })
  })

  it("releases the debugger when the session detaches", async () => {
    control.attach(SESSION, GUEST_ID)
    await send("network")
    expect(guest.debugger.attached).toBe(true)

    control.detach(SESSION)

    expect(guest.debugger.attached).toBe(false)
  })
})

describe("navigate", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  it("resolves once the guest stops loading", async () => {
    const pending = send("navigate", { url: "https://example.com/next" })
    guest.title = "Next"
    guest.emit("did-stop-loading")

    expect(resultOf(await pending)).toEqual({
      url: "https://example.com/next",
      title: "Next",
    })
  })

  it("refuses any scheme outside http, https and about:blank", async () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "chrome://settings",
    ]) {
      const response = await send("navigate", { url })
      expect(response.ok).toBe(false)
      expect(response.ok === false && response.error).toContain("Refusing to open")
    }
    expect(guest.url).toBe("https://example.com/start")
  })

  it("reports a main-frame load failure", async () => {
    const pending = send("navigate", { url: "https://nope.example/" })
    guest.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://nope.example/",
      true,
    )

    const response = await pending
    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error).toContain("ERR_NAME_NOT_RESOLVED")
  })

  it("ignores a subframe failure and an aborted load", async () => {
    const pending = send("navigate", { url: "https://example.com/next" })
    guest.emit("did-fail-load", {}, -105, "subframe", "https://ads.example/", false)
    guest.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://example.com/", true)
    guest.emit("did-stop-loading")

    expect((await pending).ok).toBe(true)
  })

  it("walks history and reloads", async () => {
    const goBack = vi.spyOn(guest, "goBack")
    const reload = vi.spyOn(guest, "reload")

    const back = send("navigate", { url: "back" })
    guest.emit("did-stop-loading")
    expect((await back).ok).toBe(true)

    const again = send("navigate", { url: "reload" })
    guest.emit("did-stop-loading")
    expect((await again).ok).toBe(true)

    expect(goBack).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("says so when there is no history to walk", async () => {
    guest.canGoBack = () => false

    const response = await send("navigate", { url: "back" })

    expect(response).toMatchObject({ ok: false, error: "There is no page to go back to." })
  })
})

describe("timeouts", () => {
  it("turns a stalled op into a failed response instead of hanging", async () => {
    vi.useFakeTimers()
    control.attach(SESSION, GUEST_ID)
    guest.executeJavaScript = () => new Promise<unknown>(() => {})

    const pending = send("snapshot")
    await vi.advanceTimersByTimeAsync(BROWSER_OP_TIMEOUT_MS + 1)
    const response = await pending

    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error).toContain("timed out")
  })
})

describe("snapshot", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  it("returns the tree the page script produced", async () => {
    guest.queueScriptResults({
      url: "https://example.com/list",
      title: "List",
      nodes: [
        { ref: "ref_1", role: "link", name: "Home", depth: 0 },
        { ref: "ref_2", role: "textbox", name: "Search", depth: 1, value: "cats" },
      ],
      truncated: false,
    })

    const snapshot = resultOf(await send("snapshot")) as unknown as BrowserSnapshot

    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.nodes[1].value).toBe("cats")
    expect(guest.evaluated[0]).toContain("__chathubRefs")
  })

  it("asks for the interactive filter by default and honours an explicit one", async () => {
    guest.queueScriptResults({ nodes: [], truncated: false }, { nodes: [], truncated: false })

    await send("snapshot")
    await send("snapshot", { filter: "all" })

    expect(guest.evaluated[0]).toContain("var wantAll = false")
    expect(guest.evaluated[1]).toContain("var wantAll = true")
  })

  it("drops nodes rather than overflow the snapshot character budget", async () => {
    guest.queueScriptResults({
      url: "https://example.com/huge",
      title: "Huge",
      nodes: Array.from({ length: 800 }, (_, index) => ({
        ref: `ref_${index + 1}`,
        role: "link",
        name: "x".repeat(110),
        depth: 0,
      })),
      truncated: false,
    })

    const snapshot = resultOf(await send("snapshot")) as unknown as BrowserSnapshot

    expect(snapshot.nodes.length).toBeLessThan(800)
    expect(snapshot.truncated).toBe(true)
  })
})

describe("click", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  it("sends a real move, down and up at the centre of the element a ref names", async () => {
    guest.queueScriptResults({ x: 10, y: 20, width: 100, height: 40, inViewport: true })

    expect((await send("click", { ref: "ref_3" })).ok).toBe(true)

    expect(guest.input).toEqual([
      { type: "mouseMove", x: 60, y: 40, modifiers: [] },
      { type: "mouseDown", x: 60, y: 40, button: "left", clickCount: 1, modifiers: [] },
      { type: "mouseUp", x: 60, y: 40, button: "left", clickCount: 1, modifiers: [] },
    ])
  })

  it("rejects an unminted ref before any input reaches the page", async () => {
    for (const ref of ["ref_0", "ref_x", "button", 3, "ref_1; drop()"]) {
      const response = await send("click", { ref })
      expect(response.ok).toBe(false)
      expect(response.ok === false && response.error).toContain("is not an element ref")
    }

    expect(guest.input).toEqual([])
    expect(guest.evaluated).toEqual([])
  })

  it("says a ref has gone stale rather than clicking the wrong pixel", async () => {
    guest.queueScriptResults(null)

    const response = await send("click", { ref: "ref_2" })

    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error).toContain("no longer on the page")
    expect(guest.input).toEqual([])
  })

  it("clicks raw coordinates with the asked-for button, count and modifiers", async () => {
    await send("click", {
      x: 12.4,
      y: 88.6,
      button: "right",
      doubleClick: true,
      modifiers: ["shift", "nonsense", "meta"],
    })

    expect(guest.input[1]).toEqual({
      type: "mouseDown",
      x: 12,
      y: 89,
      button: "right",
      clickCount: 2,
      modifiers: ["shift", "meta"],
    })
  })

  it("needs somewhere to click", async () => {
    const response = await send("click", {})

    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error).toContain("give x and y")
  })
})

describe("keyboard", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  it("focuses a ref, inserts the text and submits with Enter", async () => {
    guest.queueScriptResults({ ok: true, tag: "input", type: "search" })

    expect((await send("type", { ref: "ref_1", text: "hello", submit: true })).ok).toBe(true)

    expect(guest.inserted).toEqual(["hello"])
    expect(guest.input.map((event) => event.type)).toEqual(["keyDown", "keyUp"])
    expect(guest.input[0]).toMatchObject({ keyCode: "Enter" })
  })

  it("does not type into a ref it could not focus", async () => {
    guest.queueScriptResults({ ok: false, tag: "", type: null })

    const response = await send("type", { ref: "ref_1", text: "hello" })

    expect(response.ok).toBe(false)
    expect(guest.inserted).toEqual([])
  })

  it("sends a char event only for a printable key", async () => {
    await send("key", { key: "a" })
    await send("key", { key: "Escape", modifiers: ["control"] })

    expect(guest.input.map((event) => event.type)).toEqual([
      "keyDown",
      "char",
      "keyUp",
      "keyDown",
      "keyUp",
    ])
    expect(guest.input[3]).toEqual({
      type: "keyDown",
      keyCode: "Escape",
      modifiers: ["control"],
    })
  })
})

describe("fill", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  it("reports the kind of control the page script wrote to", async () => {
    guest.queueScriptResults({ ok: true, kind: "select" })

    expect(resultOf(await send("fill", { ref: "ref_4", value: "b" }))).toEqual({
      kind: "select",
    })
  })

  it("fails when the element cannot hold a value", async () => {
    guest.queueScriptResults({ ok: false, kind: "unknown" })

    const response = await send("fill", { ref: "ref_4", value: "b" })

    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error).toContain("Could not fill ref_4")
  })
})

describe("scroll and hover", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  it("wheels the viewport centre when nothing is anchored", async () => {
    guest.queueScriptResults({ width: 1000, height: 800 })

    await send("scroll", { direction: "down" })

    expect(guest.input[0]).toEqual({
      type: "mouseWheel",
      x: 500,
      y: 400,
      deltaX: 0,
      deltaY: -400,
      canScroll: true,
    })
  })

  it("wheels the other way for up and takes an explicit amount", async () => {
    guest.queueScriptResults({ width: 1000, height: 800 })

    await send("scroll", { direction: "up", amount: 120 })

    expect(guest.input[0]).toMatchObject({ deltaY: 120 })
  })

  it("moves the mouse over the centre of a ref", async () => {
    guest.queueScriptResults({ x: 0, y: 0, width: 40, height: 40, inViewport: true })

    await send("hover", { ref: "ref_9" })

    expect(guest.input).toEqual([
      { type: "mouseMove", x: 20, y: 20, modifiers: [] },
    ])
  })
})

describe("screenshot", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  it("returns a png data url at the captured size", async () => {
    const result = resultOf(await send("screenshot"))

    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
    expect(String(result.dataUrl)).toMatch(/^data:image\/png;base64,/)
  })

  it("shrinks a capture wider than the screenshot budget", async () => {
    guest.capturePage = async () => createImage(2800, 1600)

    const result = resultOf(await send("screenshot"))

    expect(result.width).toBe(BROWSER_SCREENSHOT_MAX_WIDTH)
    expect(result.height).toBe(800)
  })

  it("refuses to hand back an empty capture", async () => {
    guest.capturePage = async () => createImage(0, 0)

    expect(await send("screenshot")).toMatchObject({ ok: false })
  })
})

describe("page text", () => {
  it("caps what the page script hands back", async () => {
    control.attach(SESSION, GUEST_ID)
    guest.queueScriptResults({ text: "the readable body", truncated: false })

    expect(resultOf(await send("text"))).toEqual({
      text: "the readable body",
      truncated: false,
    })
  })
})

describe("console buffer", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  function log(level: number, text: string): void {
    guest.emit("console-message", {}, level, text, 12, "https://example.com/app.js")
  }

  it("keeps only the most recent messages", async () => {
    for (let index = 0; index < BROWSER_CONSOLE_BUFFER + 50; index += 1) {
      log(1, `message ${index}`)
    }

    const messages = resultOf(await send("console")).messages as unknown[]

    expect(messages).toHaveLength(BROWSER_CONSOLE_BUFFER)
    expect(messages[0]).toMatchObject({ text: "message 50", level: "info" })
  })

  it("filters to errors and honours a limit", async () => {
    log(1, "just noise")
    log(3, "first boom")
    log(2, "a warning")
    log(3, "second boom")

    const errors = resultOf(await send("console", { onlyErrors: true }))
      .messages as Array<Record<string, unknown>>

    expect(errors.map((entry) => entry.text)).toEqual(["first boom", "second boom"])

    const tail = resultOf(await send("console", { limit: 1 }))
      .messages as Array<Record<string, unknown>>

    expect(tail).toHaveLength(1)
    expect(tail[0]).toMatchObject({ text: "second boom", level: "error" })
  })

  it("reads the newer single-event console payload too", async () => {
    guest.emit("console-message", {
      level: "warning",
      message: "deprecated api",
      lineNumber: 7,
      sourceId: "https://example.com/x.js",
    })

    const messages = resultOf(await send("console")).messages as Array<
      Record<string, unknown>
    >

    expect(messages[0]).toMatchObject({
      level: "warn",
      text: "deprecated api",
      line: 7,
      source: "https://example.com/x.js",
    })
  })

  it("collects history from the moment the surface is attached", async () => {
    const fresh = new BrowserControl({
      settleMs: 0,
      resolveGuest: () => guest,
    })
    fresh.attach("late", GUEST_ID)
    log(3, "happened before the first read")

    const messages = resultOf(
      await fresh.handle({ id: "x", sessionId: "late", op: "console", params: {} }),
    ).messages as unknown[]

    expect(messages).toHaveLength(1)
    fresh.detachAll()
  })
})

describe("network buffer", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  function request(id: string, url: string): void {
    guest.debugger.emit({}, "Network.requestWillBeSent", {
      requestId: id,
      request: { method: "GET", url },
    })
  }

  it("attaches the debugger lazily and records requests and responses", async () => {
    expect(guest.debugger.attached).toBe(false)

    expect((await send("network")).ok).toBe(true)

    expect(guest.debugger.attached).toBe(true)
    expect(guest.debugger.commands).toContain("Network.enable")

    request("1", "https://example.com/app.js")
    guest.debugger.emit({}, "Network.responseReceived", {
      requestId: "1",
      response: { status: 200, mimeType: "text/javascript" },
    })
    guest.debugger.emit({}, "Network.loadingFailed", { requestId: "1" })

    const requests = resultOf(await send("network")).requests as Array<
      Record<string, unknown>
    >

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "https://example.com/app.js",
      status: 200,
      mimeType: "text/javascript",
      failed: true,
    })
  })

  it("filters by url substring and by limit", async () => {
    await send("network")
    request("1", "https://example.com/a.js")
    request("2", "https://cdn.example/b.css")
    request("3", "https://example.com/c.js")

    const filtered = resultOf(await send("network", { urlPattern: "cdn." }))
      .requests as Array<Record<string, unknown>>
    expect(filtered.map((entry) => entry.url)).toEqual(["https://cdn.example/b.css"])

    const tail = resultOf(await send("network", { limit: 1 })).requests as Array<
      Record<string, unknown>
    >
    expect(tail.map((entry) => entry.url)).toEqual(["https://example.com/c.js"])
  })

  it("explains itself when the debugger will not attach", async () => {
    guest.debugger.attach = () => {
      throw new Error("Another debugger is already attached")
    }

    const response = await send("network")

    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error).toContain(
      "Another debugger is already attached",
    )
    expect(response.ok === false && response.error).toContain("DevTools")
  })
})

describe("wait", () => {
  beforeEach(() => {
    control.attach(SESSION, GUEST_ID)
  })

  it("returns as soon as the selector matches", async () => {
    guest.queueScriptResults(true)

    expect(resultOf(await send("wait", { selector: "#ready" }))).toEqual({
      matched: true,
      selector: "#ready",
    })
  })

  it("gives up on a selector that never appears", async () => {
    guest.queueScriptResults(false)

    expect(
      resultOf(await send("wait", { selector: "#never", timeoutMs: 0 })),
    ).toEqual({ matched: false, selector: "#never" })
  })

  it("sleeps for a clamped number of milliseconds", async () => {
    expect(resultOf(await send("wait", { ms: 5 }))).toEqual({ waitedMs: 5 })

    vi.useFakeTimers()
    const pending = send("wait", { ms: 999_999 })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(resultOf(await pending)).toEqual({ waitedMs: 10_000 })
  })
})

describe("activity", () => {
  it("emits exactly one entry per op, successful or not", async () => {
    control.attach(SESSION, GUEST_ID)
    guest.queueScriptResults(
      { url: "https://example.com/", title: "T", nodes: [], truncated: false },
      { x: 0, y: 0, width: 10, height: 10, inViewport: true },
      { ok: true, kind: "input" },
      { text: "body", truncated: false },
    )

    expect((await send("snapshot")).ok).toBe(true)
    expect((await send("click", { ref: "ref_1" })).ok).toBe(true)
    expect((await send("fill", { ref: "ref_1", value: "x" })).ok).toBe(true)
    expect((await send("text")).ok).toBe(true)
    expect((await send("click", { ref: "nope" })).ok).toBe(false)

    expect(activity.map((entry) => entry.op)).toEqual([
      "snapshot",
      "click",
      "fill",
      "text",
      "click",
    ])
    expect(activity.map((entry) => entry.ok)).toEqual([true, true, true, true, false])
    expect(activity.every((entry) => entry.sessionId === SESSION)).toBe(true)
    expect(activity[0].url).toBe("https://example.com/start")
    expect(activity[0].summary).toContain("snapshot")
  })

  it("reports the refusal when no surface is attached", async () => {
    await send("snapshot")

    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({ ok: false, url: "" })
  })

  it("survives an onActivity callback that throws", async () => {
    const noisy = new BrowserControl({
      settleMs: 0,
      resolveGuest: () => guest,
      onActivity: () => {
        throw new Error("renderer bridge is gone")
      },
    })
    noisy.attach(SESSION, GUEST_ID)
    guest.queueScriptResults({ text: "body", truncated: false })

    expect(
      await noisy.handle({ id: "1", sessionId: SESSION, op: "text", params: {} }),
    ).toMatchObject({ ok: true })
    noisy.detachAll()
  })
})
