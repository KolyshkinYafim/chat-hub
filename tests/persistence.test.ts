import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { writeFileAtomic } from "../src/main/atomic-write"
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

describe("state store", () => {
  it("parks an unreadable state file instead of overwriting it", async () => {
    const folder = await dir()
    const file = join(folder, "state.json")
    await writeFile(file, '{"version":1,"sessions":[', "utf8")

    const state = await new Persistence(file).load()
    expect(state.sessions).toEqual([])
    const parked = (await readdir(folder)).filter((f) =>
      f.includes(".corrupt-"),
    )
    expect(parked).toHaveLength(1)
  })

  it("treats a missing file as a fresh install, with nothing to park", async () => {
    const folder = await dir()
    const state = await new Persistence(join(folder, "state.json")).load()
    expect(state.sessions).toEqual([])
    expect(await readdir(folder)).toEqual([])
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
