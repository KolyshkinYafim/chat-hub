import { createServer, type Server } from "node:net"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { askPermission } from "../resources/mcp/permissions-mcp.mjs"

let server: Server | undefined
let root: string | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
  server = undefined
  root = undefined
})

async function fixture(answer: string | null) {
  root = await mkdtemp(join(tmpdir(), "hp-"))
  const socketPath = join(root, "p.sock")
  const requests: Record<string, unknown>[] = []
  server = createServer(socket => {
    socket.setEncoding("utf8")
    socket.once("data", data => {
      requests.push(JSON.parse(String(data)))
      if (answer === null) socket.end()
      else socket.end(JSON.stringify({ decision: { behavior: answer } }) + "\n")
    })
  })
  server.listen(socketPath)
  await once(server, "listening")
  return { requests, env: { AGENT_DESKTOP_SOCKET: socketPath, AGENT_DESKTOP_HUB_SESSION: "hub-session", CHAT_HUB_PERMISSION_CWD: root } }
}

describe("Claude headless permissions", () => {
  it("returns allow only after the broker explicitly allows the exact input", async () => {
    const { env, requests } = await fixture("allow")
    const input = { command: "node --test" }
    expect(await askPermission({ tool_name: "Bash", input }, env)).toEqual({ behavior: "allow", updatedInput: input })
    expect(requests[0]).toMatchObject({ event: "PermissionRequest", sessionId: "hub-session", payload: { tool_name: "Bash", tool_input: input } })
  })
  for (const decision of ["deny", "cancelled", "unexpected", null]) {
    it(`denies when the broker returns ${String(decision)}`, async () => {
      const { env } = await fixture(decision)
      expect(await askPermission({ tool_name: "Bash", input: { command: "node --test" } }, env)).toMatchObject({ behavior: "deny" })
    })
  }
  it("fails closed when no UI is configured or input is malformed", async () => {
    expect(await askPermission({ tool_name: "Bash", input: {} }, {})).toMatchObject({ behavior: "deny" })
    expect(await askPermission(null, {})).toMatchObject({ behavior: "deny" })
  })
})
