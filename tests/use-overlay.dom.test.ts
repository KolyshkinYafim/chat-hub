import { act, createElement, StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  focusables,
  moveCursor,
  useOverlay,
  type OverlayOptions,
} from "../src/renderer/src/lib/use-overlay"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function harness<P>(useHook: (props: P) => void, initial: P) {
  let push: (props: P) => void = () => {}
  function Probe() {
    const [props, setProps] = useState(initial)
    push = setProps
    useHook(props)
    return null
  }
  const root = createRoot(document.createElement("div"))
  void act(() => {
    root.render(createElement(StrictMode, null, createElement(Probe)))
  })
  return {
    rerender: (props: P) => {
      void act(() => push(props))
    },
    unmount: () => {
      void act(() => root.unmount())
    },
  }
}

function mount(initial: OverlayOptions) {
  return harness((options: OverlayOptions) => useOverlay(options), initial)
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  void act(() => {
    document.body.dispatchEvent(event)
  })
  return event
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("useOverlay", () => {
  it("closes on Escape and stops the event from reaching bubble listeners", () => {
    const onClose = vi.fn()
    const leaked = vi.fn()
    window.addEventListener("keydown", leaked)
    const h = mount({ onClose })

    const event = press("Escape")
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(leaked).not.toHaveBeenCalled()

    window.removeEventListener("keydown", leaked)
    h.unmount()
  })

  it("ignores keys while disabled and re-arms when enabled flips", () => {
    const onClose = vi.fn()
    const h = mount({ onClose, enabled: false })

    press("Escape")
    expect(onClose).not.toHaveBeenCalled()

    h.rerender({ onClose, enabled: true })
    press("Escape")
    expect(onClose).toHaveBeenCalledTimes(1)
    h.unmount()
  })

  it("stops listening after unmount", () => {
    const onClose = vi.fn()
    const h = mount({ onClose })
    h.unmount()

    press("Escape")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("moves a clamped arrow cursor and leaves other keys alone", () => {
    const onClose = vi.fn()
    const onMove = vi.fn()
    const h = mount({
      onClose,
      cursor: { count: 3, active: 1, onMove },
    })

    const down = press("ArrowDown")
    expect(onMove).toHaveBeenLastCalledWith(2)
    expect(down.defaultPrevented).toBe(true)

    h.rerender({ onClose, cursor: { count: 3, active: 2, onMove } })
    press("ArrowDown")
    expect(onMove).toHaveBeenLastCalledWith(2)

    press("ArrowUp")
    expect(onMove).toHaveBeenLastCalledWith(1)

    const other = press("a")
    expect(other.defaultPrevented).toBe(false)
    expect(onMove).toHaveBeenCalledTimes(3)
    h.unmount()
  })

  it("keeps an empty arrow cursor inert", () => {
    const onMove = vi.fn()
    const h = mount({
      onClose: vi.fn(),
      cursor: { count: 0, active: 0, onMove },
    })

    const event = press("ArrowDown")
    expect(onMove).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    h.unmount()
  })

  it("wraps an arrow cursor when asked to", () => {
    const onMove = vi.fn()
    const h = mount({
      onClose: vi.fn(),
      cursor: { count: 3, active: 2, onMove, wrap: true },
    })

    press("ArrowDown")
    expect(onMove).toHaveBeenLastCalledWith(0)
    h.unmount()
  })

  it("cycles a tab cursor in both directions", () => {
    const onMove = vi.fn()
    const h = mount({
      onClose: vi.fn(),
      cursor: { count: 3, active: 2, onMove, keys: "tab" },
    })

    const forward = press("Tab")
    expect(onMove).toHaveBeenLastCalledWith(0)
    expect(forward.defaultPrevented).toBe(true)

    h.rerender({
      onClose: vi.fn(),
      cursor: { count: 3, active: 0, onMove, keys: "tab" },
    })
    press("Tab", { shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith(2)

    press("ArrowDown")
    expect(onMove).toHaveBeenCalledTimes(2)
    h.unmount()
  })

  it("hands Enter to onCommit untouched", () => {
    const onCommit = vi.fn()
    const h = mount({
      onClose: vi.fn(),
      cursor: { count: 1, active: 0, onMove: vi.fn(), onCommit },
    })

    const event = press("Enter")
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(event)
    expect(event.defaultPrevented).toBe(false)
    h.unmount()
  })

  it("traps Tab at the edges of the panel and skips disabled controls", () => {
    const panel = document.createElement("div")
    const first = document.createElement("button")
    const dead = document.createElement("button")
    dead.setAttribute("disabled", "")
    const last = document.createElement("input")
    panel.append(first, dead, last)
    document.body.append(panel)

    const h = mount({ onClose: vi.fn(), trapRef: { current: panel } })

    expect(focusables(panel)).toEqual([first, last])

    last.focus()
    const forward = press("Tab")
    expect(forward.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)

    const back = press("Tab", { shiftKey: true })
    expect(back.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)

    first.focus()
    const inside = press("Tab")
    expect(inside.defaultPrevented).toBe(false)
    h.unmount()
  })

  it("pulls focus into the trap when it is outside the panel", () => {
    const panel = document.createElement("div")
    const only = document.createElement("button")
    panel.append(only)
    const outside = document.createElement("button")
    document.body.append(panel, outside)

    const h = mount({ onClose: vi.fn(), trapRef: { current: panel } })

    outside.focus()
    press("Tab")
    expect(document.activeElement).toBe(only)
    h.unmount()
  })

  it("swallows Tab when the panel has nothing focusable", () => {
    const panel = document.createElement("div")
    document.body.append(panel)
    const h = mount({ onClose: vi.fn(), trapRef: { current: panel } })

    const event = press("Tab")
    expect(event.defaultPrevented).toBe(true)
    h.unmount()
  })
})

describe("moveCursor", () => {
  it("clamps at the ends without wrap", () => {
    expect(moveCursor(0, -1, 3, false)).toBe(0)
    expect(moveCursor(2, 1, 3, false)).toBe(2)
    expect(moveCursor(1, 1, 3, false)).toBe(2)
  })

  it("wraps across the ends with wrap", () => {
    expect(moveCursor(2, 1, 3, true)).toBe(0)
    expect(moveCursor(0, -1, 3, true)).toBe(2)
  })

  it("clamps a stale active index before moving", () => {
    expect(moveCursor(9, 1, 3, false)).toBe(2)
    expect(moveCursor(9, 1, 3, true)).toBe(0)
    expect(moveCursor(-4, -1, 3, true)).toBe(2)
  })

  it("returns null for an empty list", () => {
    expect(moveCursor(0, 1, 0, false)).toBeNull()
    expect(moveCursor(0, -1, 0, true)).toBeNull()
  })
})
