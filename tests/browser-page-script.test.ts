// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BrowserSnapshot } from "../src/shared/browser"
import {
  BROWSER_REFS_GLOBAL,
  fillScript,
  focusScript,
  rectScript,
  snapshotScript,
  textScript,
  waitForScript,
} from "../src/main/surfaces/browser-page-script"

type Rect = {
  x: number
  y: number
  width: number
  height: number
  inViewport: boolean
}

function run<T>(script: string): T {
  return eval(script) as T
}

function page(html: string): void {
  document.body.innerHTML = html
}

function snapshot(
  filter: "interactive" | "all" = "interactive",
  limit = 100,
): BrowserSnapshot {
  return run<BrowserSnapshot>(snapshotScript({ filter, limit }))
}

function refTable(): Element[] {
  return (window as unknown as Record<string, Element[]>)[BROWSER_REFS_GLOBAL]
}

function boxOf(el: Element): DOMRect {
  const zero = el.getAttribute("data-rect") === "zero"
  const width = zero ? 0 : 100
  const height = zero ? 0 : 20
  const offsetY = Number(el.getAttribute("data-top") ?? "0")
  return {
    x: 0,
    y: offsetY,
    top: offsetY,
    left: 0,
    right: width,
    bottom: offsetY + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  document.body.innerHTML = ""
  document.title = "Test page"
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return boxOf(this)
  }
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this === document.body || this === document.documentElement
        ? null
        : document.body
    },
  })
  Object.defineProperty(window, "innerWidth", { value: 1000, writable: true })
  Object.defineProperty(window, "innerHeight", { value: 800, writable: true })
})

describe("snapshot refs", () => {
  it("numbers refs in document order and keeps the elements addressable", () => {
    page(`
      <button>First</button>
      <div><a href="/second">Second</a></div>
      <button>Third</button>
    `)

    const result = snapshot()

    expect(result.nodes.map((node) => node.ref)).toEqual([
      "ref_1",
      "ref_2",
      "ref_3",
    ])
    expect(result.nodes.map((node) => node.name)).toEqual([
      "First",
      "Second",
      "Third",
    ])
    expect(refTable().map((el) => el.textContent)).toEqual([
      "First",
      "Second",
      "Third",
    ])
  })

  it("replaces the ref table on every snapshot so a stale ref cannot drift", () => {
    page("<button>Only</button>")
    snapshot()
    const first = refTable()

    page("<button>Other</button><button>More</button>")
    snapshot()

    expect(refTable()).not.toBe(first)
    expect(refTable()).toHaveLength(2)
  })

  it("reports the page url and title alongside the tree", () => {
    document.title = "Named page"
    page("<button>Go</button>")

    const result = snapshot()

    expect(result.title).toBe("Named page")
    expect(result.url).toBe(location.href)
    expect(result.truncated).toBe(false)
  })
})

describe("snapshot visibility", () => {
  it("skips elements hidden by display, visibility, aria-hidden or the hidden attribute", () => {
    page(`
      <button>Visible</button>
      <button style="display: none">Displayless</button>
      <button style="visibility: hidden">Invisible</button>
      <button aria-hidden="true">Aria hidden</button>
      <button hidden>Hidden attribute</button>
    `)

    expect(snapshot().nodes.map((node) => node.name)).toEqual(["Visible"])
  })

  it("does not descend into a hidden subtree", () => {
    page(`
      <div style="display: none"><button>Buried</button></div>
      <button>Surface</button>
    `)

    expect(snapshot().nodes.map((node) => node.name)).toEqual(["Surface"])
  })

  it("skips an element with a zero-size box", () => {
    page(`
      <button data-rect="zero">Collapsed</button>
      <button>Sized</button>
    `)

    expect(snapshot().nodes.map((node) => node.name)).toEqual(["Sized"])
  })

  it("skips an element with no offset parent unless it is positioned fixed", () => {
    page(`
      <button id="orphan">Orphan</button>
      <button id="pinned" style="position: fixed">Pinned</button>
    `)
    for (const id of ["orphan", "pinned"]) {
      Object.defineProperty(document.getElementById(id)!, "offsetParent", {
        configurable: true,
        value: null,
      })
    }

    expect(snapshot().nodes.map((node) => node.name)).toEqual(["Pinned"])
  })
})

describe("snapshot filters", () => {
  it("keeps controls and headings but drops prose when filtering to interactive", () => {
    page(`
      <h2>Section</h2>
      <p>Some prose that an agent cannot click.</p>
      <a href="/go">Go</a>
      <a>Anchor without href</a>
      <button>Press</button>
      <input placeholder="Search">
      <select><option value="a">A</option></select>
      <textarea></textarea>
      <div role="button">Custom</div>
      <div role="banner">Landmark</div>
      <span tabindex="0">Focusable</span>
      <span tabindex="-1">Skipped</span>
    `)

    const names = snapshot().nodes.map((node) => node.name)

    expect(names).toContain("Section")
    expect(names).toContain("Go")
    expect(names).toContain("Press")
    expect(names).toContain("Search")
    expect(names).toContain("Custom")
    expect(names).toContain("Focusable")
    expect(names).not.toContain("Some prose that an agent cannot click.")
    expect(names).not.toContain("Anchor without href")
    expect(names).not.toContain("Landmark")
    expect(names).not.toContain("Skipped")
  })

  it("adds text and structure when filtering to all", () => {
    page(`
      <nav><a href="/home">Home</a></nav>
      <p>Readable prose.</p>
      <ul><li>Item</li></ul>
      <img alt="Chart">
    `)

    const nodes = snapshot("all").nodes
    const roles = nodes.map((node) => node.role)

    expect(roles).toContain("nav")
    expect(roles).toContain("text")
    expect(roles).toContain("listitem")
    expect(roles).toContain("image")
    expect(nodes.map((node) => node.name)).toContain("Readable prose.")
  })

  it("nests depth by emitted ancestors rather than raw dom depth", () => {
    page(`
      <nav><div><div><a href="/deep">Deep</a></div></div></nav>
    `)

    const nodes = snapshot("all").nodes
    const nav = nodes.find((node) => node.role === "nav")
    const link = nodes.find((node) => node.role === "link")

    expect(nav?.depth).toBe(0)
    expect(link?.depth).toBe(1)
  })

  it("stops at the node limit and says so", () => {
    page(
      Array.from({ length: 6 }, (_, index) => `<button>B${index}</button>`).join(
        "",
      ),
    )

    const result = snapshot("interactive", 2)

    expect(result.nodes).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it("does not claim truncation when the tree exactly fills the limit", () => {
    page("<button>One</button><button>Two</button>")

    const result = snapshot("interactive", 2)

    expect(result.nodes).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })
})

describe("snapshot naming", () => {
  it("prefers aria-label, then alt, title, placeholder, own text and finally a label", () => {
    page(`
      <button aria-label="From aria" title="From title">From text</button>
      <img alt="From alt" title="From title">
      <button title="From title">From text</button>
      <input placeholder="From placeholder">
      <button>From text</button>
      <label for="named">From label</label><input id="named">
    `)

    expect(snapshot("all").nodes.map((node) => node.name)).toEqual([
      "From aria",
      "From alt",
      "From title",
      "From placeholder",
      "From text",
      "From label",
      "From label",
    ])
  })

  it("truncates a long name to 120 characters", () => {
    page(`<button>${"x".repeat(300)}</button>`)

    expect(snapshot().nodes[0].name).toHaveLength(120)
  })

  it("carries value, checked and disabled", () => {
    page(`
      <input id="text" value="typed">
      <input type="checkbox" checked aria-label="Agree">
      <input type="radio" aria-label="Pick">
      <button disabled>Nope</button>
      <div role="button" aria-disabled="true">Soft off</div>
    `)

    const nodes = snapshot().nodes

    expect(nodes[0].value).toBe("typed")
    expect(nodes[1].checked).toBe(true)
    expect(nodes[1].value).toBeUndefined()
    expect(nodes[2].checked).toBe(false)
    expect(nodes[3].disabled).toBe(true)
    expect(nodes[4].disabled).toBe(true)
  })

  it("masks the contents of a password field", () => {
    page('<input type="password" value="hunter2" aria-label="Password">')

    expect(snapshot().nodes[0].value).toBe("•".repeat(7))
  })
})

describe("snapshot iframes", () => {
  it("emits a cross-origin frame as one node instead of throwing", () => {
    page('<iframe title="Payments"></iframe><button>After</button>')
    Object.defineProperty(document.querySelector("iframe")!, "contentDocument", {
      configurable: true,
      get() {
        throw new Error("Blocked a frame with origin from accessing a cross-origin frame")
      },
    })

    const nodes = snapshot().nodes

    expect(nodes.map((node) => node.role)).toEqual(["iframe", "button"])
    expect(nodes[0].name).toBe("Payments")
  })
})

describe("rect script", () => {
  it("returns the viewport box of a ref minted by the last snapshot", () => {
    page('<button data-top="40">Target</button>')
    snapshot()

    const rect = run<Rect>(rectScript("ref_1"))

    expect(rect).toMatchObject({ x: 0, y: 40, width: 100, height: 20 })
    expect(rect.inViewport).toBe(true)
  })

  it("scrolls an out-of-view element into view before measuring", () => {
    page('<button data-top="4000">Far below</button>')
    snapshot()
    const target = document.querySelector("button")!
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView

    run<Rect>(rectScript("ref_1"))

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "center",
    })
  })

  it("returns null for a ref the page no longer knows", () => {
    page("<button>Target</button>")
    snapshot()

    expect(run<Rect | null>(rectScript("ref_9"))).toBeNull()
  })

  it("returns null once the element has left the document", () => {
    page("<button>Target</button>")
    snapshot()
    document.body.innerHTML = ""

    expect(run<Rect | null>(rectScript("ref_1"))).toBeNull()
  })
})

describe("focus script", () => {
  it("focuses an input and selects what is already in it", () => {
    page('<input id="field" value="existing">')
    snapshot()
    const field = document.getElementById("field") as HTMLInputElement
    const select = vi.spyOn(field, "select")

    const result = run<{ ok: boolean; tag: string; type: string | null }>(
      focusScript("ref_1"),
    )

    expect(result).toEqual({ ok: true, tag: "input", type: null })
    expect(document.activeElement).toBe(field)
    expect(select).toHaveBeenCalled()
  })

  it("reports failure for a ref that resolves to nothing", () => {
    page("<button>Target</button>")
    snapshot()

    expect(run<{ ok: boolean }>(focusScript("ref_7"))).toEqual({
      ok: false,
      tag: "",
      type: null,
    })
  })
})

describe("fill script", () => {
  it("writes a text field and fires input then change", () => {
    page('<input id="field">')
    snapshot()
    const field = document.getElementById("field") as HTMLInputElement
    const seen: string[] = []
    field.addEventListener("input", () => seen.push("input"))
    field.addEventListener("change", () => seen.push("change"))

    const result = run<{ ok: boolean; kind: string }>(
      fillScript("ref_1", "typed by an agent"),
    )

    expect(result).toEqual({ ok: true, kind: "input" })
    expect(field.value).toBe("typed by an agent")
    expect(seen).toEqual(["input", "change"])
  })

  it("writes through the native setter when a framework has shadowed value", () => {
    page('<input id="field">')
    snapshot()
    const field = document.getElementById("field") as HTMLInputElement
    const swallowed: string[] = []
    Object.defineProperty(field, "value", {
      configurable: true,
      get: () => "shadowed",
      set: (next: string) => {
        swallowed.push(next)
      },
    })

    run(fillScript("ref_1", "real value"))
    delete (field as unknown as Record<string, unknown>).value

    expect(swallowed).toEqual([])
    expect(field.value).toBe("real value")
  })

  it("ticks a checkbox and fires change", () => {
    page('<input id="box" type="checkbox">')
    snapshot()
    const box = document.getElementById("box") as HTMLInputElement
    const seen: string[] = []
    box.addEventListener("change", () => seen.push("change"))

    const result = run<{ ok: boolean; kind: string }>(fillScript("ref_1", "true"))

    expect(result).toEqual({ ok: true, kind: "checkbox" })
    expect(box.checked).toBe(true)
    expect(seen).toEqual(["change"])
  })

  it("chooses a select option by value and by visible text", () => {
    page(
      '<select id="pick"><option value="a">Apples</option><option value="b">Pears</option></select>',
    )
    snapshot()
    const pick = document.getElementById("pick") as HTMLSelectElement

    expect(run<{ kind: string }>(fillScript("ref_1", "b")).kind).toBe("select")
    expect(pick.value).toBe("b")

    run(fillScript("ref_1", "Apples"))
    expect(pick.value).toBe("a")
  })

  it("refuses an element that cannot hold a value", () => {
    page("<button>Press</button>")
    snapshot()

    expect(run<{ ok: boolean; kind: string }>(fillScript("ref_1", "x"))).toEqual({
      ok: false,
      kind: "unknown",
    })
  })
})

describe("text script", () => {
  it("prefers main content over the whole body", () => {
    page("<header>Chrome</header><main>The article body.</main>")

    expect(run<{ text: string }>(textScript(200)).text).toBe("The article body.")
  })

  it("truncates at the limit and says so", () => {
    page("<main>0123456789</main>")

    expect(run<{ text: string; truncated: boolean }>(textScript(4))).toEqual({
      text: "0123",
      truncated: true,
    })
  })
})

describe("wait-for script", () => {
  it("is true only for a selector that matches something visible", () => {
    page('<div id="ready">Ready</div><div id="later" style="display:none"></div>')

    expect(run<boolean>(waitForScript("#ready"))).toBe(true)
    expect(run<boolean>(waitForScript("#later"))).toBe(false)
    expect(run<boolean>(waitForScript("#absent"))).toBe(false)
  })

  it("is false rather than fatal for a malformed selector", () => {
    expect(run<boolean>(waitForScript("::: not a selector"))).toBe(false)
  })
})

describe("injection safety", () => {
  const escapes = ['ref_1"); window.pwned = 1; ("', "ref_1\\\") ; ({", "</script>"]

  it("cannot break out of a rect script through a hostile ref", () => {
    page("<button>Target</button>")
    snapshot()

    for (const hostile of escapes) {
      expect(run<unknown>(rectScript(hostile))).toBeNull()
    }

    expect((window as unknown as Record<string, unknown>).pwned).toBeUndefined()
  })

  it("cannot break out of a focus or fill script through a hostile ref", () => {
    page('<input id="field">')
    snapshot()

    for (const hostile of escapes) {
      expect(run<{ ok: boolean }>(focusScript(hostile)).ok).toBe(false)
      expect(run<{ ok: boolean }>(fillScript(hostile, "x")).ok).toBe(false)
    }

    expect((window as unknown as Record<string, unknown>).pwned).toBeUndefined()
  })

  it("cannot break out of a wait script through a hostile selector", () => {
    page("<div>Present</div>")

    expect(run<boolean>(waitForScript('"); window.pwned = 1; ("'))).toBe(false)
    expect((window as unknown as Record<string, unknown>).pwned).toBeUndefined()
  })

  it("carries a hostile fill value through as literal text", () => {
    page('<textarea id="field"></textarea>')
    snapshot()
    const value = 'quote " backslash \\ close </script> newline \n end'

    run(fillScript("ref_1", value))

    expect((document.getElementById("field") as HTMLTextAreaElement).value).toBe(
      value,
    )
    expect((window as unknown as Record<string, unknown>).pwned).toBeUndefined()
  })

  it("encodes interpolated values rather than pasting them into the source", () => {
    const source = rectScript('ref_1"; window.pwned = 1; "')

    expect(source).not.toContain('ref_1"; window.pwned = 1; "')
    expect(source).toContain('\\"; window.pwned = 1; \\"')
  })

  it("leaves no global behind except the ref table", () => {
    delete (window as unknown as Record<string, unknown>)[BROWSER_REFS_GLOBAL]
    const before = new Set(Object.keys(window))
    page("<button>Target</button>")

    snapshot()
    run(rectScript("ref_1"))
    run(textScript(50))
    run(waitForScript("button"))

    const added = Object.keys(window).filter((key) => !before.has(key))
    expect(added).toEqual([BROWSER_REFS_GLOBAL])
  })
})
