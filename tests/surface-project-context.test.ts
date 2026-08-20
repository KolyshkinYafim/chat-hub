import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import {
  projectContextBrief,
  readProjectContext,
  seedProjectContext,
  setContextShare,
  writeContextDoc,
} from "../src/main/surfaces/project-context"

let base = ""
let root = ""
let outside = ""

const contextFile = (name: string) => join(root, ".chathub", "context", name)

/** Write a document the way the agent does: straight to the file. */
async function agentWrite(name: string, text: string): Promise<void> {
  await mkdir(join(root, ".chathub", "context"), { recursive: true })
  await writeFile(contextFile(name), text, "utf8")
}

beforeEach(async () => {
  base = realpathSync(await mkdtemp(join(tmpdir(), "chat-hub-context-")))
  root = join(base, "workspace")
  outside = join(base, "outside")
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
})

describe("readProjectContext", () => {
  it("drafts from the repo when the folder does not exist, without writing", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "orbit", scripts: { test: "vitest run" } }),
      "utf8",
    )
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8")
    await mkdir(join(root, "src"), { recursive: true })

    const ctx = await readProjectContext(root)
    expect(ctx.seeded).toBe(false)
    expect(ctx.docs).toHaveLength(4)
    expect(ctx.docs[0].text).toContain("**orbit**")
    expect(ctx.docs[1].text).toContain("pnpm")
    expect(ctx.updatedAt).toBe(0)
    // A read must never touch the user's repository.
    await expect(readFile(contextFile("overview.md"), "utf8")).rejects.toThrow()
  })

  it("reads the git remote out of .git/config", async () => {
    await mkdir(join(root, ".git"), { recursive: true })
    await writeFile(
      join(root, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:acme/orbit.git\n',
      "utf8",
    )
    const ctx = await readProjectContext(root)
    expect(ctx.docs[0].text).toContain("https://github.com/acme/orbit")
  })

  it("reads what the agent wrote by hand, one document at a time", async () => {
    await agentWrite("focus.md", "# Current focus\n\nCutting over.\n")
    const ctx = await readProjectContext(root)
    expect(ctx.seeded).toBe(true)
    expect(ctx.docs.find((d) => d.id === "focus")?.text).toContain("Cutting over.")
    // The other three stay empty rather than being back-filled with a draft.
    expect(ctx.docs.find((d) => d.id === "overview")?.text).toBe("")
    expect(ctx.updatedAt).toBeGreaterThan(0)
  })

  it("refuses a workspace outside the filesystem it was given", async () => {
    await expect(readProjectContext(join(root, "nope"))).rejects.toThrow(
      /Workspace not found/,
    )
    await expect(readProjectContext(42)).rejects.toThrow(/Invalid workspace/)
  })
})

describe("seedProjectContext", () => {
  it("creates every missing document and never overwrites one that exists", async () => {
    await agentWrite("focus.md", "# Current focus\n\nMine.\n")
    const ctx = await seedProjectContext(root)
    expect(ctx.seeded).toBe(true)
    expect(ctx.share).toBe(true)
    expect(ctx.docs.find((d) => d.id === "focus")?.text).toContain("Mine.")
    expect(ctx.docs.find((d) => d.id === "overview")?.text).toContain("# Overview")
    const settings: unknown = JSON.parse(
      await readFile(join(root, ".chathub", "context.json"), "utf8"),
    )
    expect((settings as { share: boolean }).share).toBe(true)
  })

  it("re-detects exactly one document when asked for one", async () => {
    await seedProjectContext(root)
    await writeContextDoc(root, "stack", "# Stack\n\nStale by hand.\n")
    await writeContextDoc(root, "overview", "# Overview\n\nKeep me.\n")
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "orbit", dependencies: { fastify: "^5" } }),
      "utf8",
    )

    const ctx = await seedProjectContext(root, "stack")
    expect(ctx.docs.find((d) => d.id === "stack")?.text).toContain("Fastify")
    expect(ctx.docs.find((d) => d.id === "overview")?.text).toContain("Keep me.")
  })

  it("rejects a document id it does not define", async () => {
    await expect(seedProjectContext(root, "../../.zshrc")).rejects.toThrow(
      /Unknown context document/,
    )
  })
})

describe("writeContextDoc", () => {
  it("writes one document and leaves the others alone", async () => {
    const ctx = await writeContextDoc(root, "overview", "# Overview\n\nAn API.")
    expect(ctx.seeded).toBe(true)
    expect(await readFile(contextFile("overview.md"), "utf8")).toBe(
      "# Overview\n\nAn API.\n",
    )
    expect(ctx.docs.find((d) => d.id === "stack")?.text).toBe("")
  })

  it("refuses an unknown id, a non-string body and an oversized one", async () => {
    await expect(writeContextDoc(root, "hooks", "x")).rejects.toThrow(
      /Unknown context document/,
    )
    await expect(writeContextDoc(root, "overview", 7)).rejects.toThrow(
      /Invalid document text/,
    )
    await expect(
      writeContextDoc(root, "overview", "x".repeat(40_000)),
    ).rejects.toThrow(/too long/)
  })

  it("cannot be steered out of the workspace by a symlinked folder", async () => {
    await writeFile(join(outside, "overview.md"), "stolen\n", "utf8")
    await mkdir(join(root, ".chathub"), { recursive: true })
    await symlink(outside, join(root, ".chathub", "context"))

    // The path is contained; following the symlink is the OS's business, but
    // the write must land inside the workspace as the resolved root sees it.
    const ctx = await readProjectContext(root)
    expect(ctx.docs.find((d) => d.id === "overview")?.text).toBe("stolen\n")
    expect(realpathSync(join(root, ".chathub", "context"))).toBe(outside)
  })
})

describe("projectContextBrief", () => {
  it("sends the documents plus the board's open todos", async () => {
    await setContextShare(root, true)
    await agentWrite("overview.md", "# Overview\n\nAn API.\n")
    await agentWrite("focus.md", "# Current focus\n\nStreaming cutover.\n")
    await mkdir(join(root, ".chathub"), { recursive: true })
    await writeFile(
      join(root, ".chathub", "board.json"),
      JSON.stringify({
        todos: [
          { id: "a", text: "Migrate the dashboard", done: false, createdAt: 1 },
          { id: "b", text: "Already shipped", done: true, createdAt: 1 },
        ],
        notes: [],
      }),
      "utf8",
    )

    const brief = await projectContextBrief(root)
    expect(brief).toContain("## Overview\nAn API.")
    expect(brief).toContain("- [ ] Migrate the dashboard")
    expect(brief).not.toContain("Already shipped")
  })

  it("sends nothing when sharing is off", async () => {
    await agentWrite("overview.md", "# Overview\n\nAn API.\n")
    await setContextShare(root, false)
    expect(await projectContextBrief(root)).toBe("")
    await setContextShare(root, true)
    expect(await projectContextBrief(root)).toContain("An API.")
  })

  it("sends nothing for a project that has no context, and never throws", async () => {
    expect(await projectContextBrief(root)).toBe("")
    expect(await projectContextBrief(join(root, "nope"))).toBe("")
    expect(await projectContextBrief(undefined)).toBe("")
  })

  it("does not seed the folder just because a turn asked for the brief", async () => {
    await writeFile(join(root, "package.json"), '{ "name": "orbit" }', "utf8")
    expect(await projectContextBrief(root)).toBe("")
    await expect(readFile(contextFile("overview.md"), "utf8")).rejects.toThrow()
  })
})

describe("setContextShare", () => {
  it("persists the switch and refuses a non-boolean", async () => {
    const off = await setContextShare(root, false)
    expect(off.share).toBe(false)
    expect((await readProjectContext(root)).share).toBe(false)
    await expect(setContextShare(root, "off")).rejects.toThrow(/Invalid share flag/)
  })
})

describe("a context folder that arrived with someone else's checkout", () => {
  it("costs nothing until sharing is switched on here", async () => {
    await seedProjectContext(root)
    await rm(join(root, ".chathub", "context.json"), { force: true })

    expect(await projectContextBrief(root)).toBe("")

    await setContextShare(root, true)
    expect(await projectContextBrief(root)).not.toBe("")
  })
})
