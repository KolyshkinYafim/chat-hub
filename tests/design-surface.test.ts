// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DesignSurface } from "@renderer/components/surfaces/DesignSurface"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

class StubResizeObserver {
  observe() {}
  disconnect() {}
}

function installBridge(listDir: (cwd: string, rel: string) => Promise<unknown>) {
  Object.defineProperty(window, "chatHub", {
    configurable: true,
    value: { listDir, readFileText: () => Promise.reject(new Error("unused")) },
  })
  ;(globalThis as Record<string, unknown>).ResizeObserver = StubResizeObserver
}

async function mount(props: { cwd: string; focus?: { path: string; at: number } }) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(DesignSurface, props))
    await Promise.resolve()
    await Promise.resolve()
  })
  return { host, root }
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("DesignSurface", () => {
  it("shows an empty canvas without asking for a design folder the project lacks", async () => {
    const listDir = vi.fn((_cwd: string, rel: string) =>
      rel === ""
        ? Promise.resolve({ path: "", entries: [{ name: "src", path: "src", kind: "dir" }] })
        : Promise.reject(new Error(`Not found: ${rel}`)),
    )
    installBridge(listDir)
    const { host, root } = await mount({ cwd: "/repo" })
    expect(host.textContent).toContain("No artboards")
    expect(listDir.mock.calls.map(([, rel]) => rel)).toEqual([""])
    act(() => root.unmount())
  })

  it("lists the default folder once the root says it exists", async () => {
    const listDir = vi.fn((_cwd: string, rel: string) =>
      Promise.resolve(
        rel === ""
          ? { path: "", entries: [{ name: "design", path: "design", kind: "dir" }] }
          : { path: "design", entries: [] },
      ),
    )
    installBridge(listDir)
    const { host, root } = await mount({ cwd: "/repo" })
    expect(host.textContent).toContain("No artboards")
    expect(listDir.mock.calls.map(([, rel]) => rel)).toEqual(["", "design"])
    act(() => root.unmount())
  })

  it("reports a folder the user picked explicitly when it is missing", async () => {
    const listDir = vi.fn((_cwd: string, rel: string) =>
      Promise.reject(new Error(`Not found: ${rel}`)),
    )
    installBridge(listDir)
    const { host, root } = await mount({ cwd: "/repo", focus: { path: "mockups", at: 1 } })
    expect(host.textContent).toContain("Could not open the folder")
    expect(listDir.mock.calls.every(([, rel]) => rel === "mockups")).toBe(true)
    act(() => root.unmount())
  })
})
