import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { SessionModePicker } from "../src/renderer/src/components/SessionModePicker"
import { DEFAULT_MODES } from "../src/shared/settings-types"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  const onSelect = vi.fn()
  await act(async () => {
    root!.render(
      createElement(SessionModePicker, {
        modes: DEFAULT_MODES,
        modeId: "code",
        onSelect,
      }),
    )
  })
  return { host, onSelect }
}

it("keeps one mode control and closes its menu on Escape", async () => {
  const { host } = await mount()
  const trigger = host.querySelector<HTMLButtonElement>(".session-mode-trigger")!
  expect(host.querySelectorAll(".session-mode-trigger")).toHaveLength(1)

  await act(async () => trigger.click())
  expect(host.querySelector(".session-mode-menu")).not.toBeNull()

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  })
  expect(host.querySelector(".session-mode-menu")).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it("applies one selected mode and dismisses the menu", async () => {
  const { host, onSelect } = await mount()
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".session-mode-trigger")!.click()
  })
  const plan = Array.from(
    host.querySelectorAll<HTMLButtonElement>(".session-mode-option"),
  ).find((button) => button.textContent?.includes("Plan"))!
  await act(async () => plan.click())

  expect(onSelect).toHaveBeenCalledOnce()
  expect(onSelect).toHaveBeenCalledWith("plan")
  expect(host.querySelector(".session-mode-menu")).toBeNull()
})
