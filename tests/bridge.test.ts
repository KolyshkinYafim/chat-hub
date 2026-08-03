import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { SessionMonitorBridge } from "../src/main/bridge"

async function bridgeIn(limits: { maxBytes: number; keepLines: number }) {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-bridge-"))
  const file = join(dir, "events.jsonl")
  return { bridge: new SessionMonitorBridge(file, limits), file }
}

describe("bridge rotation", () => {
  it("caps the file and keeps the newest lines", async () => {
    const { bridge, file } = await bridgeIn({ maxBytes: 2000, keepLines: 5 })
    for (let i = 0; i < 200; i++) {
      bridge.publish({ type: "session.status", id: `s${i}`, status: "running" })
    }
    await bridge.flush()

    const body = await readFile(file, "utf8")
    const lines = body.split("\n").filter(Boolean)
    // Rotation drops the oldest history; the newest events must all be intact.
    expect((await stat(file)).size).toBeLessThanOrEqual(2000)
    expect(lines.at(-1)).toContain("s199")
    expect(body).not.toContain('"s0"')
    // Every line must still be a whole event — a torn trim breaks the consumer.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it("trims in place so the Monitor's tail and hook appends survive", async () => {
    const { bridge, file } = await bridgeIn({ maxBytes: 1000, keepLines: 3 })
    bridge.publish({ type: "session.ended", id: "first", reason: "done" })
    await bridge.flush()
    const before = await stat(file)

    for (let i = 0; i < 100; i++) {
      bridge.publish({ type: "session.status", id: `s${i}`, status: "idle" })
    }
    await bridge.flush()

    expect((await stat(file)).ino).toBe(before.ino)
  })

  it("leaves a small file untouched", async () => {
    const { bridge, file } = await bridgeIn({ maxBytes: 1_000_000, keepLines: 2 })
    for (let i = 0; i < 10; i++) {
      bridge.publish({ type: "session.status", id: `s${i}`, status: "idle" })
    }
    await bridge.flush()
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean)
    expect(lines).toHaveLength(10)
  })
})
