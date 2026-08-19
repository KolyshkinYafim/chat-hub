// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  PICK_GLOBAL,
  disablePickScript,
  enablePickScript,
  readPickScript,
  type PickTarget,
} from "../src/renderer/src/lib/pick-script"
import {
  addPick,
  buildPickMessage,
  clearPicks,
  listPicks,
  onPreviewPicksChanged,
  prunePreviewPicks,
  removePick,
  type PreviewPickInput,
} from "../src/renderer/src/lib/preview-picks"

const SESSION = "session-a"
const OTHER = "session-b"

type PickState = {
  pending: PickTarget | null
  overlay: HTMLElement
}

function run<T>(script: string): T {
  return eval(script) as T
}

function page(html: string): void {
  document.body.innerHTML = html
}

function pickState(): PickState | undefined {
  return (window as unknown as Record<string, PickState | undefined>)[
    PICK_GLOBAL
  ]
}

function overlayIn(doc: Document): Element | null {
  return doc.querySelector("[data-chathub-pick-overlay]")
}

function click(el: Element): boolean {
  return el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  )
}

function pickOn(el: Element): PickTarget {
  click(el)
  const pending = pickState()?.pending
  expect(pending).toBeTruthy()
  return pending as PickTarget
}

function pickInput(overrides: Partial<PreviewPickInput> = {}): PreviewPickInput {
  return {
    selector: "form.checkout > button.primary",
    tag: "button",
    text: "Submit order",
    rect: { x: 4, y: 8, width: 120, height: 32 },
    note: "The click target is too small on mobile.",
    ...overrides,
  }
}

afterEach(() => {
  run(disablePickScript())
  document.body.innerHTML = ""
  prunePreviewPicks(new Set())
})

describe("enablePickScript", () => {
  it("stores a pending pick whose selector resolves to the clicked element", () => {
    page(`<main><button id="save">  Save
      order </button></main>`)
    run(enablePickScript())
    const button = document.getElementById("save") as HTMLElement
    const pick = pickOn(button)
    expect(pick.selector).toBe("#save")
    expect(document.querySelectorAll(pick.selector)).toHaveLength(1)
    expect(document.querySelector(pick.selector)).toBe(button)
    expect(pick.tag).toBe("button")
    expect(pick.text).toBe("Save order")
  })

  it("prevents the default action and stops propagation", () => {
    page(`<button id="go">Go</button>`)
    run(enablePickScript())
    const button = document.getElementById("go") as HTMLElement
    const reached = vi.fn()
    button.addEventListener("click", reached)
    const notCancelled = click(button)
    expect(notCancelled).toBe(false)
    expect(reached).not.toHaveBeenCalled()
  })

  it("collapses whitespace and trims the text to 120 characters", () => {
    const long = `${"x".repeat(80)}   \n\t ${"y".repeat(80)}`
    page(`<p id="wall">${long}</p>`)
    run(enablePickScript())
    const pick = pickOn(document.getElementById("wall") as HTMLElement)
    expect(pick.text).toHaveLength(120)
    expect(pick.text).toBe(`${"x".repeat(80)} ${"y".repeat(39)}`)
    expect(pick.text.includes("\n")).toBe(false)
  })

  it("records the enclosing link target as href", () => {
    page(`<nav><a id="docs" href="/docs"><span>Docs</span></a></nav>`)
    run(enablePickScript())
    const span = document.querySelector("span") as HTMLElement
    const pick = pickOn(span)
    expect(pick.tag).toBe("span")
    expect(pick.href).toContain("/docs")
  })

  it("carries a plain serializable rect", () => {
    page(`<button id="b">B</button>`)
    run(enablePickScript())
    const pick = pickOn(document.getElementById("b") as HTMLElement)
    expect(JSON.parse(JSON.stringify(pick.rect))).toEqual(pick.rect)
    expect(typeof pick.rect.width).toBe("number")
  })

  it("is idempotent and keeps a single overlay", () => {
    page(`<button id="b">B</button>`)
    run(enablePickScript())
    run(enablePickScript())
    expect(
      document.querySelectorAll("[data-chathub-pick-overlay]"),
    ).toHaveLength(1)
  })

  it("moves the overlay on hover without touching the element's styles", () => {
    page(`<button id="b">B</button>`)
    run(enablePickScript())
    const button = document.getElementById("b") as HTMLElement
    button.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        right: 110,
        bottom: 50,
        width: 100,
        height: 30,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    const overlay = overlayIn(document) as HTMLElement
    expect(overlay.style.display).toBe("block")
    expect(overlay.style.left).toBe("10px")
    expect(overlay.style.top).toBe("20px")
    expect(overlay.style.width).toBe("100px")
    expect(overlay.style.height).toBe("30px")
    expect(button.getAttribute("style")).toBeNull()
  })
})

describe("selector builder", () => {
  it("prefers a unique id over everything else", () => {
    page(`
      <div class="card"><button id="one" class="btn">A</button></div>
      <div class="card"><button class="btn">B</button></div>
    `)
    run(enablePickScript())
    const pick = pickOn(document.getElementById("one") as HTMLElement)
    expect(pick.selector).toBe("#one")
  })

  it("skips a duplicated id and still resolves uniquely", () => {
    page(`
      <section><button id="dup" class="a">First</button></section>
      <aside><button id="dup" class="a">Second</button></aside>
    `)
    run(enablePickScript())
    const second = document.querySelector("aside button") as HTMLElement
    const pick = pickOn(second)
    expect(pick.selector).not.toBe("#dup")
    expect(document.querySelectorAll(pick.selector)).toHaveLength(1)
    expect(document.querySelector(pick.selector)).toBe(second)
  })

  it("falls back to data-testid when there is no id", () => {
    page(`
      <button class="btn" data-testid="submit">Go</button>
      <button class="btn">Stop</button>
    `)
    run(enablePickScript())
    const target = document.querySelector("[data-testid]") as HTMLElement
    const pick = pickOn(target)
    expect(pick.selector).toBe('[data-testid="submit"]')
    expect(document.querySelector(pick.selector)).toBe(target)
  })

  it("stays unique on ambiguous class soup via nth-of-type", () => {
    page(`
      <ul>
        <li class="row item">a</li>
        <li class="row item">b</li>
        <li class="row item">c</li>
      </ul>
    `)
    run(enablePickScript())
    const middle = document.querySelectorAll("li")[1] as HTMLElement
    const pick = pickOn(middle)
    expect(pick.selector).toContain(":nth-of-type(")
    expect(document.querySelectorAll(pick.selector)).toHaveLength(1)
    expect(document.querySelector(pick.selector)).toBe(middle)
  })

  it("resolves deeply nested twins to the right node", () => {
    page(`
      <div class="wrap"><div class="box"><span class="t">x</span></div></div>
      <div class="wrap"><div class="box"><span class="t">x</span></div></div>
    `)
    run(enablePickScript())
    const spans = document.querySelectorAll("span.t")
    const pick = pickOn(spans[1] as HTMLElement)
    expect(document.querySelectorAll(pick.selector)).toHaveLength(1)
    expect(document.querySelector(pick.selector)).toBe(spans[1])
  })
})

describe("readPickScript", () => {
  it("returns the pending pick once and clears it", () => {
    page(`<button id="b">B</button>`)
    run(enablePickScript())
    click(document.getElementById("b") as HTMLElement)
    const first = run<PickTarget | null>(readPickScript())
    expect(first?.selector).toBe("#b")
    expect(pickState()?.pending).toBeNull()
    expect(run<PickTarget | null>(readPickScript())).toBeNull()
  })

  it("returns null when picking was never enabled", () => {
    expect(run<PickTarget | null>(readPickScript())).toBeNull()
  })
})

describe("disablePickScript", () => {
  it("removes the overlay, the listeners, and the global", () => {
    page(`<button id="b">B</button>`)
    run(enablePickScript())
    expect(overlayIn(document)).not.toBeNull()
    expect(run<boolean>(disablePickScript())).toBe(true)
    expect(overlayIn(document)).toBeNull()
    expect(pickState()).toBeUndefined()
    const notCancelled = click(document.getElementById("b") as HTMLElement)
    expect(notCancelled).toBe(true)
    expect(pickState()).toBeUndefined()
  })

  it("reports false when nothing was installed", () => {
    expect(run<boolean>(disablePickScript())).toBe(false)
  })
})

describe("preview pick store", () => {
  it("adds picks per session with distinct ids in insertion order", () => {
    const first = addPick(SESSION, pickInput())
    const second = addPick(SESSION, pickInput({ note: "Second." }))
    expect(first.id).not.toBe(second.id)
    expect(listPicks(SESSION)).toEqual([first, second])
    expect(listPicks(OTHER)).toEqual([])
  })

  it("removes a single pick", () => {
    const first = addPick(SESSION, pickInput())
    const second = addPick(SESSION, pickInput({ note: "Keep me." }))
    removePick(SESSION, first.id)
    expect(listPicks(SESSION)).toEqual([second])
  })

  it("ignores a removal for the wrong session or id", () => {
    const kept = addPick(SESSION, pickInput())
    removePick(OTHER, kept.id)
    removePick(SESSION, "pp-nope")
    expect(listPicks(SESSION)).toEqual([kept])
  })

  it("clears one session's batch and leaves the other", () => {
    addPick(SESSION, pickInput())
    const kept = addPick(OTHER, pickInput())
    clearPicks(SESSION)
    expect(listPicks(SESSION)).toEqual([])
    expect(listPicks(OTHER)).toEqual([kept])
  })

  it("prunes sessions that are no longer live", () => {
    addPick(SESSION, pickInput())
    const kept = addPick(OTHER, pickInput())
    prunePreviewPicks(new Set([OTHER]))
    expect(listPicks(SESSION)).toEqual([])
    expect(listPicks(OTHER)).toEqual([kept])
  })

  it("returns copies that do not alias the store", () => {
    addPick(SESSION, pickInput())
    listPicks(SESSION).pop()
    expect(listPicks(SESSION)).toHaveLength(1)
  })

  it("notifies listeners on changes and supports unsubscribe", () => {
    const seen = vi.fn()
    const off = onPreviewPicksChanged(seen)
    addPick(SESSION, pickInput())
    clearPicks(SESSION)
    off()
    addPick(SESSION, pickInput())
    expect(seen).toHaveBeenCalledTimes(2)
  })
})

describe("buildPickMessage", () => {
  it("returns null for an empty batch", () => {
    expect(buildPickMessage("http://localhost:5173/", [])).toBeNull()
  })

  it("formats a single pick exactly", () => {
    const pick = addPick(SESSION, pickInput())
    expect(buildPickMessage("http://localhost:5173/", [pick])).toBe(
      [
        "Notes on the page http://localhost:5173/:",
        "",
        'button "Submit order" (form.checkout > button.primary)',
        "The click target is too small on mobile.",
      ].join("\n"),
    )
  })

  it("keeps multiple picks in insertion order separated by blank lines", () => {
    const first = addPick(SESSION, pickInput({ note: "First note." }))
    const second = addPick(
      SESSION,
      pickInput({
        selector: "#pricing",
        tag: "section",
        text: "Pricing",
        note: "Second note.",
      }),
    )
    expect(buildPickMessage("http://localhost:5173/", [first, second])).toBe(
      [
        "Notes on the page http://localhost:5173/:",
        "",
        'button "Submit order" (form.checkout > button.primary)',
        "First note.",
        "",
        'section "Pricing" (#pricing)',
        "Second note.",
      ].join("\n"),
    )
  })

  it("appends the href and drops the quoted text when it is empty", () => {
    const link = addPick(
      SESSION,
      pickInput({
        selector: "nav > a:nth-of-type(2)",
        tag: "a",
        text: "Docs",
        href: "http://localhost:5173/docs",
        note: "Link points at the old docs.",
      }),
    )
    const bare = addPick(
      SESSION,
      pickInput({ selector: "hr.divider", tag: "hr", text: "", note: "Drop this." }),
    )
    expect(buildPickMessage("http://localhost:5173/", [link, bare])).toBe(
      [
        "Notes on the page http://localhost:5173/:",
        "",
        'a "Docs" (nav > a:nth-of-type(2)) → http://localhost:5173/docs',
        "Link points at the old docs.",
        "",
        "hr (hr.divider)",
        "Drop this.",
      ].join("\n"),
    )
  })
})
