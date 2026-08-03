import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { lockPathFor, withBridgeLock } from "../src/main/bridge-lock"
import { SessionMonitorBridge } from "../src/main/bridge"

async function tempFile(name = "events.jsonl") {
  const dir = await mkdtemp(join(tmpdir(), "chat-hub-lock-"))
  return join(dir, name)
}

describe("bridge lock", () => {
  it("takes and releases the sibling .lock the Swift trimmer looks for", async () => {
    const file = await tempFile()
    const lock = lockPathFor(file)
    expect(lock).toBe(`${file}.lock`)

    let sawLock = false
    const held = await withBridgeLock(file, async (locked) => {
      sawLock = existsSync(lock)
      return locked
    })

    expect(held).toBe(true)
    expect(sawLock).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  it("releases the lock even when the body throws", async () => {
    const file = await tempFile()
    await expect(
      withBridgeLock(file, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(existsSync(lockPathFor(file))).toBe(false)
  })

  it("breaks a stale lock left by a process that died mid-trim", async () => {
    const file = await tempFile()
    const lock = lockPathFor(file)
    await writeFile(lock, "", "utf8")
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)

    const held = await withBridgeLock(file, async (locked) => locked)
    expect(held).toBe(true)
  })

  it("fails open rather than blocking the bridge on a live foreign lock", async () => {
    const file = await tempFile()
    const lock = lockPathFor(file)
    await writeFile(lock, "", "utf8") // fresh: another process is mid-trim

    const started = Date.now()
    let ran = false
    const held = await withBridgeLock(file, async (locked) => {
      ran = true
      return locked
    })

    expect(ran).toBe(true)
    expect(held).toBe(false)
    // Bounded wait — an agent turn must never queue behind a stuck lock.
    expect(Date.now() - started).toBeLessThan(4_000)
    // Someone else's lock is left alone while it is fresh.
    expect(existsSync(lock)).toBe(true)
  })

  it("skips the destructive trim when the lock could not be taken", async () => {
    const file = await tempFile()
    await writeFile(
      file,
      Array.from({ length: 400 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n",
      "utf8",
    )
    const before = (await stat(file)).size
    await writeFile(lockPathFor(file), "", "utf8") // foreign lock, fresh

    const bridge = new SessionMonitorBridge(file, { maxBytes: 100, keepLines: 10 })
    bridge.publish({ type: "session.status", id: "s1", status: "idle" })
    await bridge.flush()

    // The append still happened; only the rewrite that could eat someone else's
    // append was deferred.
    const after = await readFile(file, "utf8")
    expect(after.length).toBeGreaterThan(before)
    expect(after.split("\n").filter(Boolean).length).toBe(401)
  })

  it("trims once the lock is free again", async () => {
    const file = await tempFile()
    await writeFile(
      file,
      Array.from({ length: 400 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n",
      "utf8",
    )

    const bridge = new SessionMonitorBridge(file, { maxBytes: 100, keepLines: 10 })
    bridge.publish({ type: "session.status", id: "s1", status: "idle" })
    await bridge.flush()

    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean)
    expect(lines).toHaveLength(10)
    // Newest lines survive: the published event is the last one.
    expect(JSON.parse(lines[lines.length - 1]).id).toBe("s1")
  })
})
