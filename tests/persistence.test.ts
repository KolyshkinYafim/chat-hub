import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { writeFileAtomic } from "../src/main/atomic-write"
import { MessageArchive } from "../src/main/message-archive"
import { Persistence } from "../src/main/persistence"
import { parseGrokModels } from "../src/main/provider-probe"

async function dir() {
  return mkdtemp(join(tmpdir(), "chat-hub-persist-"))
}

describe("atomic writes", () => {
  it("publishes a whole document when saves overlap", async () => {
    const file = join(await dir(), "state.json")
    const payloads = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ n: i, filler: "x".repeat(i * 500) }),
    )
    await Promise.all(payloads.map((p) => writeFileAtomic(file, p)))

    const raw = await readFile(file, "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()
    // Last writer wins, and no tmp file is left behind for the next boot.
    expect(raw).toBe(payloads.at(-1))
    const left = await readdir(join(file, ".."))
    expect(left.filter((f) => f.endsWith(".tmp"))).toEqual([])
  })
})

function legacyState() {
  return {
    version: 1,
    sessions: [
      { id: "s1", title: "One", project: "p", provider: "claude", cwd: "/tmp", status: "idle", createdAt: 1, updatedAt: 2 },
      { id: "s2", title: "Two", project: "p", provider: "claude", cwd: "/tmp", status: "idle", createdAt: 1, updatedAt: 3 },
    ],
    messages: {
      s1: [
        { id: "m1", sessionId: "s1", role: "assistant", content: "edited two files", createdAt: 3, touchedFiles: ["a.ts", "b.ts"] },
        { id: "m2", sessionId: "s1", role: "user", content: "thanks", createdAt: 4 },
      ],
      s2: [
        { id: "m3", sessionId: "s2", role: "user", content: "hi", createdAt: 5 },
      ],
    },
    usage: { s1: { turns: 2, costUsd: 0.5 } },
    activeSessionId: "s1",
  }
}

describe("state store", () => {
  it("parks an unreadable legacy state file instead of overwriting it", async () => {
    const folder = await dir()
    const file = join(folder, "state.json")
    await writeFile(file, '{"version":1,"sessions":[', "utf8")

    const index = await new Persistence(file).loadIndex()
    expect(index.sessions).toEqual([])
    const parked = (await readdir(folder)).filter((f) =>
      f.includes(".corrupt-"),
    )
    expect(parked).toHaveLength(1)
  })

  it("treats a missing file as a fresh install, with nothing to park", async () => {
    const folder = await dir()
    const index = await new Persistence(join(folder, "state.json")).loadIndex()
    expect(index.sessions).toEqual([])
    expect(await readdir(folder)).toEqual([])
  })

  it("splits a legacy state.json into an index plus per-session hot files", async () => {
    const folder = await dir()
    const file = join(folder, "state.json")
    await writeFile(file, JSON.stringify(legacyState()), "utf8")

    const store = new Persistence(file)
    const index = await store.loadIndex()

    expect(index.sessions.map((s) => s.id)).toEqual(["s1", "s2"])
    expect(index.usage).toEqual({ s1: { turns: 2, costUsd: 0.5 } })
    expect(index.activeSessionId).toBe("s1")

    const s1 = await store.loadHotMessages("s1")
    expect(s1.map((m) => m.content)).toEqual(["edited two files", "thanks"])
    expect(s1[0]).not.toHaveProperty("touchedFiles")
    expect(await store.loadHotMessages("s2")).toHaveLength(1)

    const files = await readdir(folder)
    expect(files).not.toContain("state.json")
    expect(files.filter((f) => f.startsWith("state.json.legacy-"))).toHaveLength(1)
    expect(files).toContain("index.json")
  })

  it("keeps the legacy backup byte-identical", async () => {
    const folder = await dir()
    const file = join(folder, "state.json")
    const raw = JSON.stringify(legacyState())
    await writeFile(file, raw, "utf8")

    await new Persistence(file).loadIndex()

    const backup = (await readdir(folder)).find((f) =>
      f.startsWith("state.json.legacy-"),
    )
    expect(backup).toBeDefined()
    expect(await readFile(join(folder, backup!), "utf8")).toBe(raw)
  })

  it("never migrates twice", async () => {
    const folder = await dir()
    const file = join(folder, "state.json")
    await writeFile(file, JSON.stringify(legacyState()), "utf8")

    const store = new Persistence(file)
    await store.loadIndex()
    await store.saveIndex({
      version: 1,
      sessions: [],
      usage: {},
      activeSessionId: null,
    })
    await writeFile(file, JSON.stringify(legacyState()), "utf8")

    const again = await new Persistence(file).loadIndex()
    expect(again.sessions).toEqual([])
    const backups = (await readdir(folder)).filter((f) =>
      f.startsWith("state.json.legacy-"),
    )
    expect(backups).toHaveLength(1)
  })

  it("parks a corrupt hot file and serves an empty transcript", async () => {
    const folder = await dir()
    const store = new Persistence(join(folder, "state.json"))
    await store.saveHotMessages("s1", [
      { id: "m1", sessionId: "s1", role: "user", content: "hi", createdAt: 1 },
    ])
    await writeFile(store.hotPathFor("s1"), "{broken", "utf8")

    expect(await store.loadHotMessages("s1")).toEqual([])
    const parked = (await readdir(join(folder, "sessions", "s1"))).filter((f) =>
      f.includes(".corrupt-"),
    )
    expect(parked).toHaveLength(1)
  })

  it("rejects a session id that escapes the sessions directory", async () => {
    const store = new Persistence(join(await dir(), "state.json"))
    expect(() => store.hotPathFor("../evil")).toThrow(/Invalid session id/)
  })
})

describe("spilled transcript", () => {
  it("drops a removed message field from archived lines too", async () => {
    const folder = await dir()
    const archive = MessageArchive.fromStatePath(join(folder, "state.json"))
    const file = archive.fileFor("s1")
    await mkdir(join(file, ".."), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        content: "spilled turn",
        createdAt: 1,
        touchedFiles: ["a.ts"],
      }) + "\n",
      "utf8",
    )

    const page = await archive.loadBefore("s1", null, 50)
    expect(page.messages[0]).not.toHaveProperty("touchedFiles")
    expect(page.messages[0]?.content).toBe("spilled turn")
  })
})

describe("grok catalog parsing", () => {
  it("reads the ids the CLI actually offers", () => {
    const raw = [
      "You are not authenticated.",
      "",
      "Default model: grok-4.5",
      "",
      "Available models:",
      "  * grok-4.5 (default)",
      "  - grok-code",
      "",
    ].join("\n")
    expect(parseGrokModels(raw)).toEqual([
      { id: "grok-4.5", label: "grok-4.5" },
      { id: "grok-code", label: "grok-code" },
    ])
  })

  it("returns nothing when the CLI printed no catalog", () => {
    expect(parseGrokModels("command not found")).toEqual([])
  })
})
