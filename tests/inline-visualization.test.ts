// @vitest-environment jsdom

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import {
  InlineVisualization,
  relativeVisualizationPath,
} from "@renderer/components/InlineVisualization"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

describe("relativeVisualizationPath", () => {
  it("keeps project-relative paths", () => {
    expect(relativeVisualizationPath("/repo", "work/status.html")).toBe("work/status.html")
  })

  it("converts absolute paths inside the workspace", () => {
    expect(relativeVisualizationPath("/repo", "/repo/work/status.html")).toBe(
      "work/status.html",
    )
  })

  it("rejects sibling paths with a shared prefix", () => {
    expect(relativeVisualizationPath("/repo", "/repo-other/status.html")).toBeNull()
  })

  it("loads a project fragment into a sandboxed iframe", async () => {
    Object.defineProperty(window, "chatHub", {
      configurable: true,
      value: {
        listDir: () => Promise.resolve({ path: "", entries: [] }),
        readFileText: () => Promise.resolve({
          path: "work/status.html",
          text: '<button type="button">Interactive</button>',
          truncated: false,
          binary: false,
          stamp: { mtimeMs: 1, size: 42 },
        }),
      },
    })
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(InlineVisualization, {
        cwd: "/repo",
        refInfo: {
          path: "/repo/work/status.html",
          title: "Status",
          wide: true,
        },
      }))
      await Promise.resolve()
    })
    const frame = host.querySelector("iframe")
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts")
    expect(frame?.srcdoc).toContain("Interactive")
    expect(frame?.title).toBe("Status")
    act(() => root.unmount())
    host.remove()
  })
})
