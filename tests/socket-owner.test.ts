import { createServer, type Server } from "node:net"
import { existsSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  clearStaleSocket,
  SocketInUseError,
  socketAnswers,
} from "../src/main/socket-owner"

let dir = ""
let server: Server | null = null

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  server = null
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe("clearStaleSocket", () => {
  it("removes a socket file nobody answers on", async () => {
    dir = await mkdtemp(join(tmpdir(), "sock-"))
    const path = join(dir, "hub.sock")
    writeFileSync(path, "")
    expect(await socketAnswers(path)).toBe(false)
    await clearStaleSocket(path)
    expect(existsSync(path)).toBe(false)
  })

  it("refuses to touch a socket another process still serves", async () => {
    dir = await mkdtemp(join(tmpdir(), "sock-"))
    const path = join(dir, "hub.sock")
    server = createServer(() => {})
    await new Promise<void>((r) => server!.listen(path, r))
    expect(await socketAnswers(path)).toBe(true)
    await expect(clearStaleSocket(path)).rejects.toBeInstanceOf(SocketInUseError)
    expect(existsSync(path)).toBe(true)
  })

  it("is quiet about a path that does not exist yet", async () => {
    dir = await mkdtemp(join(tmpdir(), "sock-"))
    await expect(clearStaleSocket(join(dir, "none.sock"))).resolves.toBeUndefined()
  })
})
