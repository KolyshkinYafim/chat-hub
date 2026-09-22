import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PlanSteps } from "../src/renderer/src/components/PlanSteps"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let cleanup = () => {}

afterEach(() => {
  cleanup()
  cleanup = () => {}
  document.body.innerHTML = ""
})

describe("plan to Board handoff", () => {
  it("reveals the project Board from a structured plan card", async () => {
    const onOpenBoard = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        createElement(PlanSteps, {
          steps: [{ text: "Verify Browser workflow", status: "in_progress" }],
          onOpenBoard,
        }),
      )
    })
    cleanup = () => { void act(() => root.unmount()) }

    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "Board ↗",
    )
    expect(button).toBeDefined()
    await act(async () => button!.click())

    expect(onOpenBoard).toHaveBeenCalledTimes(1)
  })
})
