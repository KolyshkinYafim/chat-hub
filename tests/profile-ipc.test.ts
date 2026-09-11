import { connect } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  agentDesktopCommandsPath, agentDesktopEventsPath, agentDesktopSocketPath,
  chatHubBrowserSocketPath, chatHubSocketPath,
} from "../src/shared/bridge-path"
import { BrowserSocketServer } from "../src/main/browser-socket"
import { HubPermissionServer } from "../src/main/permission-socket"
import { prepareSocketPath } from "../src/main/socket-path"

const dirs = new Set<string>()
const servers: { stop: () => Promise<void> }[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.clear()
  vi.unstubAllEnvs()
})
function endpoints() {
  return [agentDesktopEventsPath(), agentDesktopCommandsPath(), agentDesktopSocketPath(), chatHubSocketPath(), chatHubBrowserSocketPath()]
}
async function profile() {
  const path = await mkdtemp(join(tmpdir(), "ch-profile-test-"))
  dirs.add(path)
  vi.stubEnv("CHAT_HUB_USER_DATA", path)
  const paths = endpoints()
  dirs.add(dirname(paths[3]))
  return paths
}
async function canConnect(path: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path)
    socket.once("error", reject)
    socket.once("connect", () => { socket.destroy(); resolve() })
  })
}

describe("profile IPC isolation", () => {
  it("isolates all defaults and restores Session Monitor production paths", async () => {
    vi.stubEnv("CHAT_HUB_USER_DATA", "")
    const production = endpoints()
    const first = await profile()
    const second = await profile()
    for (let i = 0; i < first.length; i++) {
      expect(first[i]).not.toBe(second[i])
      expect(first[i]).not.toBe(production[i])
    }
    vi.stubEnv("CHAT_HUB_USER_DATA", "")
    expect(endpoints()).toEqual(production)
  })

  it("keeps explicit integration endpoint overrides", async () => {
    await profile()
    vi.stubEnv("CHAT_HUB_SOCKET", "/tmp/custom-hub.sock")
    vi.stubEnv("AGENT_DESKTOP_EVENTS", "/tmp/custom-events.jsonl")
    expect(chatHubSocketPath()).toBe("/tmp/custom-hub.sock")
    expect(agentDesktopEventsPath()).toBe("/tmp/custom-events.jsonl")
  })

  for (const kind of ["browser", "permissions"] as const) {
    it(`${kind}: another profile can start and stop without unlinking the first`, async () => {
      const firstPaths = await profile()
      const secondPaths = await profile()
      const index = kind === "browser" ? 4 : 3
      const create = (path: string) => kind === "browser"
        ? new BrowserSocketServer(path, async (request) => ({ id: request.id, ok: true, result: {} }))
        : new HubPermissionServer(path, () => {})
      const first = create(firstPaths[index])
      const second = create(secondPaths[index])
      servers.push(first, second)
      await first.start()
      await second.start()
      await second.stop()
      expect(existsSync(firstPaths[index])).toBe(true)
      await canConnect(firstPaths[index])
      const intruder = create(firstPaths[index])
      servers.push(intruder)
      await expect(intruder.start()).rejects.toThrow(/already in use/)
      await intruder.stop()
      await canConnect(firstPaths[index])
    })
  }

  it("refuses to unlink a regular file placed at a socket path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ch-file-test-"))
    dirs.add(dir)
    const file = join(dir, "hub.sock")
    await writeFile(file, "keep me")
    await expect(prepareSocketPath(file)).rejects.toThrow(/non-socket/)
    expect(existsSync(file)).toBe(true)
  })
})
