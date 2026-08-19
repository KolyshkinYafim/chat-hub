import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import {
  isValidScriptCommand,
  isValidScriptHotkey,
  parseScriptsFile,
  SCRIPTS_REL_PATH,
  type ProjectScript,
} from "../src/shared/scripts"
import { readScripts, writeScripts } from "../src/main/surfaces/scripts"

let root = ""
let file = ""

async function handWrite(raw: unknown): Promise<void> {
  await mkdir(join(root, ".chathub"), { recursive: true })
  await writeFile(file, typeof raw === "string" ? raw : JSON.stringify(raw, null, 2), "utf8")
}

const script = (over: Partial<ProjectScript> & { command: string }): ProjectScript => ({
  id: over.id ?? over.command,
  name: over.name ?? over.command,
  command: over.command,
  autoOpenPreview: over.autoOpenPreview ?? false,
  runOnWorktreeCreate: over.runOnWorktreeCreate ?? false,
  ...(over.hotkey === undefined ? {} : { hotkey: over.hotkey }),
  ...(over.previewUrl === undefined ? {} : { previewUrl: over.previewUrl }),
})

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "chat-hub-scripts-")))
  file = join(root, SCRIPTS_REL_PATH)
})

describe("parseScriptsFile", () => {
  it("reads garbage of any shape as an empty list", () => {
    for (const garbage of [null, undefined, 42, "nope", [], { scripts: "x" }]) {
      expect(parseScriptsFile(garbage)).toEqual({ scripts: [], updatedAt: 0 })
    }
  })

  it("keeps known fields and drops unknown keys on a script", () => {
    const parsed = parseScriptsFile({
      scripts: [
        {
          id: "test",
          name: "Test",
          command: "pnpm test",
          hotkey: "1",
          previewUrl: "http://localhost:5173",
          autoOpenPreview: true,
          runOnWorktreeCreate: true,
          icon: "rocket",
          shell: "/bin/evil",
        },
      ],
    })
    expect(parsed.scripts).toEqual([
      {
        id: "test",
        name: "Test",
        command: "pnpm test",
        hotkey: "1",
        previewUrl: "http://localhost:5173",
        autoOpenPreview: true,
        runOnWorktreeCreate: true,
      },
    ])
  })

  it("drops a script whose command is empty or starts with a dash", () => {
    const parsed = parseScriptsFile({
      scripts: [
        { id: "a", name: "Empty", command: "   " },
        { id: "b", name: "Flags", command: "--rm -rf /" },
        { id: "c", name: "Ok", command: "pnpm test" },
      ],
    })
    expect(parsed.scripts.map((s) => s.id)).toEqual(["c"])
  })

  it("strips an invalid hotkey but keeps the script", () => {
    const parsed = parseScriptsFile({
      scripts: [
        { id: "a", command: "pnpm test", hotkey: "0" },
        { id: "b", command: "pnpm dev", hotkey: "12" },
        { id: "c", command: "pnpm lint", hotkey: "x" },
      ],
    })
    expect(parsed.scripts).toHaveLength(3)
    expect(parsed.scripts.every((s) => s.hotkey === undefined)).toBe(true)
  })

  it("keeps the first claim on a duplicated id and on a duplicated hotkey", () => {
    const parsed = parseScriptsFile({
      scripts: [
        { id: "a", name: "First", command: "pnpm test", hotkey: "1" },
        { id: "a", name: "Impostor", command: "pnpm evil" },
        { id: "b", name: "Second", command: "pnpm dev", hotkey: "1" },
      ],
    })
    expect(parsed.scripts.map((s) => s.name)).toEqual(["First", "Second"])
    expect(parsed.scripts[0]?.hotkey).toBe("1")
    expect(parsed.scripts[1]?.hotkey).toBeUndefined()
  })

  it("refuses autoOpenPreview without a usable http(s) preview URL", () => {
    const parsed = parseScriptsFile({
      scripts: [
        { id: "a", command: "pnpm dev", autoOpenPreview: true },
        { id: "b", command: "pnpm dev", previewUrl: "ftp://x", autoOpenPreview: true },
      ],
    })
    expect(parsed.scripts.map((s) => s.autoOpenPreview)).toEqual([false, false])
    expect(parsed.scripts.every((s) => s.previewUrl === undefined)).toBe(true)
  })

  it("gives an id-less hand-written script a generated id", () => {
    const parsed = parseScriptsFile({ scripts: [{ name: "Dev", command: "pnpm dev" }] })
    expect(parsed.scripts[0]?.id).toBeTruthy()
  })
})

describe("hotkey and command validators", () => {
  it("accepts exactly the digits 1 through 9 as hotkeys", () => {
    for (let digit = 1; digit <= 9; digit++) {
      expect(isValidScriptHotkey(String(digit))).toBe(true)
    }
    for (const bad of ["0", "10", "", "a", " 1"]) {
      expect(isValidScriptHotkey(bad)).toBe(false)
    }
  })

  it("rejects empty and leading-dash commands", () => {
    expect(isValidScriptCommand("pnpm test")).toBe(true)
    expect(isValidScriptCommand("  ")).toBe(false)
    expect(isValidScriptCommand("-rf /")).toBe(false)
    expect(isValidScriptCommand("  --version")).toBe(false)
  })
})

describe("readScripts / writeScripts", () => {
  it("reads a workspace that never had a scripts file as empty", async () => {
    await expect(readScripts(root)).resolves.toEqual({ scripts: [], updatedAt: 0 })
  })

  it("reads a malformed file as empty instead of throwing", async () => {
    await handWrite("{ not json")
    await expect(readScripts(root)).resolves.toEqual({ scripts: [], updatedAt: 0 })
  })

  it("round-trips a save through .chathub/scripts.json", async () => {
    const saved = await writeScripts(root, [
      script({ id: "test", name: "Test", command: "pnpm test", hotkey: "1" }),
      script({
        id: "dev",
        name: "Dev",
        command: "pnpm dev",
        previewUrl: "http://localhost:5173",
        autoOpenPreview: true,
      }),
    ])
    expect(saved.updatedAt).toBeGreaterThan(0)
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { scripts: unknown[] }
    expect(onDisk.scripts).toHaveLength(2)
    const read = await readScripts(root)
    expect(read).toEqual(saved)
  })

  it("normalizes on save so a bad row never reaches the file", async () => {
    const saved = await writeScripts(root, [
      script({ id: "ok", command: "pnpm test" }),
      { id: "bad", name: "Bad", command: "-x" },
    ])
    expect(saved.scripts.map((s) => s.id)).toEqual(["ok"])
    expect((await readScripts(root)).scripts.map((s) => s.id)).toEqual(["ok"])
  })

  it("refuses a workspace path that does not exist", async () => {
    await expect(readScripts(join(root, "missing"))).rejects.toThrow()
  })
})
