import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  grokFolderTrusted,
  isFolderTrusted,
  parseTrustedFolders,
  readGrokTrust,
  trustGrokFolder,
  upsertTrustedFolder,
} from "../src/main/grok-trust"

const REAL_WORLD_STORE = `[folders."/Users/yafimkolyshkin/FinanceApp"]
trusted = true
decided_at = 1784654214

[folders."/Users/yafimkolyshkin/Gambit/NSFW"]
trusted = true
decided_at = 1784531349

[folders."/Users/yafimkolyshkin/ProxyFlash"]
trusted = true
decided_at = 1784888094
`

let workspace = ""

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "grok-trust-"))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function storePath(): string {
  return join(workspace, "trusted_folders.toml")
}

describe("parseTrustedFolders", () => {
  it("reads every folder out of a real trust store", () => {
    const decisions = parseTrustedFolders(REAL_WORLD_STORE)

    expect([...decisions]).toEqual([
      ["/Users/yafimkolyshkin/FinanceApp", true],
      ["/Users/yafimkolyshkin/Gambit/NSFW", true],
      ["/Users/yafimkolyshkin/ProxyFlash", true],
    ])
  })

  it("decodes a quoted path containing a space", () => {
    const text = `[folders."/Users/me/My Projects/side quest"]\ntrusted = true\n`

    expect(parseTrustedFolders(text).get("/Users/me/My Projects/side quest")).toBe(
      true,
    )
  })

  it("decodes escaped quotes and backslashes in a path", () => {
    const text = `[folders."/Users/me/say \\"hi\\"/a\\\\b"]\ntrusted = true\n`

    expect(parseTrustedFolders(text).get('/Users/me/say "hi"/a\\b')).toBe(true)
  })

  it("accepts the keys in either order and ignores unknown ones", () => {
    const text = `[folders."/a"]\ndecided_at = 7\nsource = "cli"\ntrusted = true\n`

    expect(parseTrustedFolders(text).get("/a")).toBe(true)
  })

  it("records an explicit trusted = false as a decision, not as trust", () => {
    const text = `[folders."/a"]\ntrusted = false\ndecided_at = 7\n`

    expect(parseTrustedFolders(text).get("/a")).toBe(false)
  })

  it("ignores comments and blank lines around the entries", () => {
    const text = `# grok folder trust\n\n[folders."/a"] # the project\ntrusted = true # granted\n`

    expect(parseTrustedFolders(text).get("/a")).toBe(true)
  })

  it("ignores trusted keys that sit under an unrelated table", () => {
    const text = `[settings]\ntrusted = true\n`

    expect(parseTrustedFolders(text).size).toBe(0)
  })

  it("rejects a malformed folder header instead of guessing at the path", () => {
    const text = `[folders./a]\ntrusted = true\n\n[folders."/b"\ntrusted = true\n`

    expect(parseTrustedFolders(text).size).toBe(0)
  })

  it("yields an empty map for garbage", () => {
    expect(parseTrustedFolders("<<< not toml at all >>>").size).toBe(0)
    expect(parseTrustedFolders("").size).toBe(0)
  })
})

describe("isFolderTrusted", () => {
  it("trusts the folder named in the store", () => {
    expect(
      isFolderTrusted(REAL_WORLD_STORE, "/Users/yafimkolyshkin/FinanceApp"),
    ).toBe(true)
  })

  it("inherits trust from an ancestor, matching Grok's own semantics", () => {
    expect(
      isFolderTrusted(
        REAL_WORLD_STORE,
        "/Users/yafimkolyshkin/FinanceApp/backend/src",
      ),
    ).toBe(true)
  })

  it("does not let a shared name prefix leak trust to a sibling", () => {
    expect(
      isFolderTrusted(REAL_WORLD_STORE, "/Users/yafimkolyshkin/FinanceAppOther"),
    ).toBe(false)
  })

  it("does not trust a parent of a trusted folder", () => {
    expect(isFolderTrusted(REAL_WORLD_STORE, "/Users/yafimkolyshkin")).toBe(false)
  })

  it("ignores a trailing slash on either side of the comparison", () => {
    const text = `[folders."/Users/me/app/"]\ntrusted = true\n`

    expect(isFolderTrusted(text, "/Users/me/app/")).toBe(true)
    expect(isFolderTrusted(text, "/Users/me/app")).toBe(true)
  })

  it("treats trusted = false as untrusted", () => {
    const text = `[folders."/Users/me/app"]\ntrusted = false\ndecided_at = 7\n`

    expect(isFolderTrusted(text, "/Users/me/app")).toBe(false)
    expect(isFolderTrusted(text, "/Users/me/app/src")).toBe(false)
  })

  it("trusts a folder reached through a symlink into a trusted tree", () => {
    const real = join(workspace, "project")
    const link = join(workspace, "shortcut")
    mkdirSync(join(real, "src"), { recursive: true })
    symlinkSync(real, link)
    const text = `[folders.${JSON.stringify(real)}]\ntrusted = true\n`

    expect(isFolderTrusted(text, join(link, "src"))).toBe(true)
  })

  it("trusts nothing when the store is garbage", () => {
    expect(isFolderTrusted("<<< not toml >>>", "/Users/me/app")).toBe(false)
  })
})

describe("upsertTrustedFolder", () => {
  it("appends a new folder and leaves the other entries byte-for-byte", () => {
    const next = upsertTrustedFolder(REAL_WORLD_STORE, "/Users/me/app", 1700)

    expect(next.startsWith(REAL_WORLD_STORE)).toBe(true)
    expect(next.slice(REAL_WORLD_STORE.length)).toBe(
      `\n[folders."/Users/me/app"]\ntrusted = true\ndecided_at = 1700\n`,
    )
  })

  it("flips an existing trusted = false without disturbing its neighbours", () => {
    const text = `[folders."/a"]\ntrusted = true\ndecided_at = 1\n\n[folders."/b"]\ntrusted = false\ndecided_at = 2\n\n[folders."/c"]\ntrusted = true\ndecided_at = 3\n`

    const next = upsertTrustedFolder(text, "/b", 99)

    expect(next).toBe(
      `[folders."/a"]\ntrusted = true\ndecided_at = 1\n\n[folders."/b"]\ntrusted = true\ndecided_at = 99\n\n[folders."/c"]\ntrusted = true\ndecided_at = 3\n`,
    )
  })

  it("adds the missing keys to a folder table that has neither", () => {
    const text = `[folders."/a"]\nsource = "cli"\n`

    expect(upsertTrustedFolder(text, "/a", 42)).toBe(
      `[folders."/a"]\ntrusted = true\ndecided_at = 42\nsource = "cli"\n`,
    )
  })

  it("keeps comments and unrelated tables verbatim", () => {
    const text = `# hand-written header\n\n[other]\nvalue = 1\n\n[folders."/a"]\ntrusted = false\n`

    expect(upsertTrustedFolder(text, "/a", 5)).toBe(
      `# hand-written header\n\n[other]\nvalue = 1\n\n[folders."/a"]\ndecided_at = 5\ntrusted = true\n`,
    )
  })

  it("escapes a path with a quote in it so the result parses back", () => {
    const folder = '/Users/me/say "hi"'

    const next = upsertTrustedFolder("", folder, 8)

    expect(parseTrustedFolders(next).get(folder)).toBe(true)
  })

  it("matches an existing entry through a trailing slash instead of duplicating it", () => {
    const text = `[folders."/a/b"]\ntrusted = false\ndecided_at = 1\n`

    const next = upsertTrustedFolder(text, "/a/b/", 2)

    expect(parseTrustedFolders(next).size).toBe(1)
    expect(parseTrustedFolders(next).get("/a/b")).toBe(true)
  })

  it("is idempotent", () => {
    const once = upsertTrustedFolder(REAL_WORLD_STORE, "/Users/me/app", 1700)

    expect(upsertTrustedFolder(once, "/Users/me/app", 1700)).toBe(once)
  })

  it("writes a lone entry into an empty store without a leading blank line", () => {
    expect(upsertTrustedFolder("", "/a", 3)).toBe(
      `[folders."/a"]\ntrusted = true\ndecided_at = 3\n`,
    )
  })
})

describe("readGrokTrust", () => {
  it("reports an empty store for a file that is not there", async () => {
    const missing = join(workspace, "nope", "trusted_folders.toml")

    expect(await readGrokTrust(missing)).toEqual({ path: missing, text: "" })
  })
})

describe("trustGrokFolder", () => {
  it("round-trips a folder through the store file", async () => {
    const project = join(workspace, "project")
    mkdirSync(project)

    expect(await grokFolderTrusted(project, storePath())).toBe(false)
    expect(await trustGrokFolder(project, storePath(), 1_700_000_000_000)).toBe(
      true,
    )
    expect(await grokFolderTrusted(project, storePath())).toBe(true)
    expect(await readFile(storePath(), "utf8")).toContain(
      "decided_at = 1700000000",
    )
  })

  it("grants a subdirectory its trust through the ancestor entry", async () => {
    const project = join(workspace, "project")
    mkdirSync(join(project, "packages", "web"), { recursive: true })
    await trustGrokFolder(project, storePath())

    expect(
      await grokFolderTrusted(join(project, "packages", "web"), storePath()),
    ).toBe(true)
  })

  it("keeps the folders Grok already trusted", async () => {
    writeFileSync(storePath(), REAL_WORLD_STORE)
    const project = join(workspace, "project")
    mkdirSync(project)

    await trustGrokFolder(project, storePath())
    const text = await readFile(storePath(), "utf8")

    expect(text.startsWith(REAL_WORLD_STORE)).toBe(true)
    expect(parseTrustedFolders(text).size).toBe(4)
  })

  it("refuses the home directory and the filesystem root", async () => {
    await expect(trustGrokFolder("/", storePath())).rejects.toThrow(/refuses/)
    await expect(
      trustGrokFolder(process.env.HOME ?? "/", storePath()),
    ).rejects.toThrow(/refuses/)
  })

  it("refuses a relative path", async () => {
    await expect(trustGrokFolder("project", storePath())).rejects.toThrow(
      /absolute/,
    )
  })

  it("writes a well-formed store even while Grok holds the trust lock", async () => {
    writeFileSync(storePath(), REAL_WORLD_STORE)
    writeFileSync(`${storePath()}.lock`, `${process.pid}:${Math.floor(Date.now() / 1000)}`)
    const project = join(workspace, "project")
    mkdirSync(project)

    expect(await trustGrokFolder(project, storePath())).toBe(true)
    const text = await readFile(storePath(), "utf8")

    expect(text.startsWith(REAL_WORLD_STORE)).toBe(true)
    expect(parseTrustedFolders(text).size).toBe(4)
  })

  it("does not wait on a lock left behind by a dead writer", async () => {
    writeFileSync(`${storePath()}.lock`, "")
    const project = join(workspace, "project")
    mkdirSync(project)

    const started = Date.now()
    await trustGrokFolder(project, storePath())

    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
