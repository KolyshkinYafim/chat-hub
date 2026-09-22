import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { InlineLink, LinkActions } from "../src/renderer/src/components/InlineText"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  document.body.innerHTML = ""
})

function mount(onOpenBrowser: (url: string) => void) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  void act(() => {
    root.render(
      createElement(
        LinkActions.Provider,
        { value: onOpenBrowser },
        createElement(InlineLink, { url: "https://example.com/research" }, "Research"),
      ),
    )
  })
  cleanup = () => { void act(() => root.unmount()) }
  return host.querySelector<HTMLAnchorElement>("a")!
}

function click(link: HTMLAnchorElement, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  })
  void act(() => link.dispatchEvent(event))
  return event
}

describe("agent transcript links", () => {
  it("uses an ordinary click to open the linked page in the Browser surface", () => {
    const onOpenBrowser = vi.fn()
    const link = mount(onOpenBrowser)

    const event = click(link)

    expect(event.defaultPrevented).toBe(true)
    expect(onOpenBrowser).toHaveBeenCalledWith("https://example.com/research")
    expect(link.title).toContain("open in Browser panel")
  })

  it("keeps modifier-clicks available for the system browser", () => {
    const onOpenBrowser = vi.fn()
    const link = mount(onOpenBrowser)

    const event = click(link, { metaKey: true })

    expect(event.defaultPrevented).toBe(false)
    expect(onOpenBrowser).not.toHaveBeenCalled()
  })
})
