import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NewSessionDialog, type NewSessionDraft } from "../src/renderer/src/components/NewSessionDialog"
import { DEFAULT_PERMISSION_MODE } from "../src/shared/permission"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const project = { id: "p", name: "Repo", cwd: "/tmp/repo", createdAt: 1, updatedAt: 1 }
const mcp = { config: { version: 1, servers: [{ id: "clickup", name: "clickup", enabled: true, transport: "http", args: [], envKeys: [] }] }, statuses: [], envKeysByServer: {} }
let cleanup = () => {}

afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals() })

async function mount() {
  const onCreate = vi.fn<(draft: NewSessionDraft) => Promise<void>>().mockResolvedValue(undefined)
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
  Object.defineProperty(window, "chatHub", { configurable: true, value: {
    listProjects: vi.fn().mockResolvedValue([project]),
    listSessions: vi.fn().mockResolvedValue([]),
    mcpList: vi.fn().mockResolvedValue(mcp),
    getSettings: vi.fn().mockResolvedValue({ permissionMode: DEFAULT_PERMISSION_MODE }),
  } })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(NewSessionDialog, {
    open: true, providers: [{ id: "claude", label: "Claude", available: true }], enabledProviderIds: ["claude"], statuses: [], initialProvider: "claude", onClose: vi.fn(), onCreate,
  })))
  cleanup = () => { void act(() => root.unmount()) }
  return { host, onCreate }
}

async function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === text)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("new chat from task", () => {
  it("shows enabled sources and submits the edited prompt with source metadata", async () => {
    const { host, onCreate } = await mount()
    expect(host.textContent).toContain("ClickUp")
    expect([...host.querySelectorAll('[role="radio"]')].some((item) => item.textContent === "Sentry")).toBe(false)
    await click(host, "ClickUp")
    await fill(host.querySelector<HTMLInputElement>('[aria-label="Source reference"]')!, "ABC-123")
    const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="First message"]')!
    expect(prompt.value).toContain("Read task ABC-123")
    await fill(prompt, "Read ABC-123 and implement only its first acceptance criterion.")
    await click(host, "Start chat")
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/repo",
      origin: { kind: "clickup", ref: "ABC-123", url: "https://app.clickup.com/t/ABC-123" },
      firstPrompt: "Read ABC-123 and implement only its first acceptance criterion.",
    }))
  })
  it("does not create a session for an invalid source", async () => {
    const { host, onCreate } = await mount()
    await click(host, "Link")
    await fill(host.querySelector<HTMLInputElement>('[aria-label="Source reference"]')!, "javascript:alert(1)")
    await click(host, "Start chat")
    expect(onCreate).not.toHaveBeenCalled()
    expect(host.textContent).toContain("Use an HTTP or HTTPS link")
  })
})
