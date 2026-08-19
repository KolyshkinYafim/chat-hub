import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  listProjectFiles,
  searchProjectContent,
} from "../src/main/surfaces/project-search"
import { fuzzyScore } from "@renderer/lib/fuzzy"

const exec = promisify(execFile)

async function makeGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "chat-hub-psearch-git-"))
  await exec("git", ["init", "-q"], { cwd: repo })
  await writeFile(join(repo, ".gitignore"), "*.log\n")
  await mkdir(join(repo, "src"))
  await writeFile(
    join(repo, "src", "alpha.ts"),
    'const greeting = "Hello World"\nconst other = 1\nconst reprise = "hello again"\n',
  )
  await writeFile(join(repo, "ignored.log"), "hello from the ignored file\n")
  await writeFile(
    join(repo, "binary.dat"),
    Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from("hello inside")]),
  )
  await exec("git", ["add", ".gitignore", "src/alpha.ts", "binary.dat"], {
    cwd: repo,
  })
  await writeFile(join(repo, "untracked.txt"), "untracked HELLO here\n")
  return repo
}

async function makePlainFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chat-hub-psearch-plain-"))
  await mkdir(join(root, "docs"))
  await mkdir(join(root, "node_modules"))
  await mkdir(join(root, ".cache"))
  await writeFile(join(root, "readme.md"), "# Title\n\nplain hello line\n")
  await writeFile(join(root, "docs", "guide.md"), "first\nsecond\nHeLLo there\n")
  await writeFile(join(root, "node_modules", "dep.js"), "hello from a dep\n")
  await writeFile(join(root, ".cache", "blob.txt"), "hello cached\n")
  await writeFile(join(root, ".DS_Store"), "hello finder\n")
  await writeFile(
    join(root, "image.bin"),
    Buffer.concat([Buffer.from([0]), Buffer.from("hello binary")]),
  )
  return root
}

describe("listProjectFiles in a git checkout", () => {
  it("respects .gitignore, sees staged and untracked files, hides .git", async () => {
    const repo = await makeGitRepo()
    const files = await listProjectFiles(repo)
    expect(files).toContain("src/alpha.ts")
    expect(files).toContain("binary.dat")
    expect(files).toContain("untracked.txt")
    expect(files).toContain(".gitignore")
    expect(files).not.toContain("ignored.log")
    expect(files.some((f) => f.startsWith(".git/"))).toBe(false)
  })

  it("caps the list at the given limit", async () => {
    const repo = await makeGitRepo()
    expect(await listProjectFiles(repo, 2)).toHaveLength(2)
  })
})

describe("listProjectFiles outside git", () => {
  it("walks the tree, skipping hidden dirs, node_modules and .DS_Store", async () => {
    const root = await makePlainFolder()
    const files = await listProjectFiles(root)
    expect(files).toContain("readme.md")
    expect(files).toContain("docs/guide.md")
    expect(files).toContain("image.bin")
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false)
    expect(files.some((f) => f.startsWith(".cache/"))).toBe(false)
    expect(files).not.toContain(".DS_Store")
    expect([...files].sort()).toEqual(files)
  })

  it("caps the walk at the given limit", async () => {
    const root = await makePlainFolder()
    expect(await listProjectFiles(root, 2)).toHaveLength(2)
  })
})

describe("searchProjectContent in a git checkout", () => {
  it("finds lines with correct numbers, case-insensitively, in tracked and untracked files", async () => {
    const repo = await makeGitRepo()
    const hits = await searchProjectContent(repo, "hello")
    expect(hits).toContainEqual({
      path: "src/alpha.ts",
      line: 1,
      text: 'const greeting = "Hello World"',
    })
    expect(hits).toContainEqual({
      path: "src/alpha.ts",
      line: 3,
      text: 'const reprise = "hello again"',
    })
    expect(hits).toContainEqual({
      path: "untracked.txt",
      line: 1,
      text: "untracked HELLO here",
    })
    expect(hits.some((h) => h.path === "ignored.log")).toBe(false)
    expect(hits.some((h) => h.path === "binary.dat")).toBe(false)
  })

  it("returns nothing for a query with no matches", async () => {
    const repo = await makeGitRepo()
    expect(await searchProjectContent(repo, "zebra-quux")).toEqual([])
  })

  it("caps hits per file at 20 and trims long lines to 200 chars", async () => {
    const repo = await makeGitRepo()
    const many = Array.from({ length: 30 }, (_, i) => `needle row ${i}`).join(
      "\n",
    )
    await writeFile(join(repo, "many.txt"), `${many}\n`)
    await writeFile(join(repo, "long.txt"), `${"needle ".repeat(60)}\n`)
    const hits = await searchProjectContent(repo, "needle")
    const inFile = hits.filter((h) => h.path === "many.txt")
    expect(inFile).toHaveLength(20)
    expect(inFile[0]).toMatchObject({ line: 1 })
    const long = hits.find((h) => h.path === "long.txt")
    expect(long?.text).toHaveLength(200)
  })

  it("respects the total limit option", async () => {
    const repo = await makeGitRepo()
    await writeFile(
      join(repo, "spread"),
      Array.from({ length: 10 }, () => "needle").join("\n"),
    )
    const hits = await searchProjectContent(repo, "needle", { limit: 4 })
    expect(hits).toHaveLength(4)
  })

  it("tolerates a tracked file vanishing from disk", async () => {
    const repo = await makeGitRepo()
    await writeFile(join(repo, "gone.txt"), "hello then gone\n")
    await exec("git", ["add", "gone.txt"], { cwd: repo })
    await rm(join(repo, "gone.txt"))
    const hits = await searchProjectContent(repo, "hello")
    expect(hits.some((h) => h.path === "gone.txt")).toBe(false)
    expect(hits.some((h) => h.path === "src/alpha.ts")).toBe(true)
  })
})

describe("searchProjectContent outside git", () => {
  it("finds lines case-insensitively with correct numbers and skips binaries", async () => {
    const root = await makePlainFolder()
    const hits = await searchProjectContent(root, "hello")
    expect(hits).toContainEqual({
      path: "docs/guide.md",
      line: 3,
      text: "HeLLo there",
    })
    expect(hits).toContainEqual({
      path: "readme.md",
      line: 3,
      text: "plain hello line",
    })
    expect(hits.some((h) => h.path === "image.bin")).toBe(false)
    expect(hits.some((h) => h.path.startsWith("node_modules/"))).toBe(false)
  })

  it("skips an unreadable file instead of throwing", async () => {
    const root = await makePlainFolder()
    await writeFile(join(root, "locked.txt"), "hello locked\n")
    await chmod(join(root, "locked.txt"), 0)
    const hits = await searchProjectContent(root, "hello")
    expect(hits.some((h) => h.path === "locked.txt")).toBe(false)
    expect(hits.some((h) => h.path === "readme.md")).toBe(true)
    await chmod(join(root, "locked.txt"), 0o644)
  })

  it("respects per-file and total caps", async () => {
    const root = await makePlainFolder()
    await writeFile(
      join(root, "dense.txt"),
      Array.from({ length: 40 }, () => "needle").join("\n"),
    )
    const all = await searchProjectContent(root, "needle")
    expect(all.filter((h) => h.path === "dense.txt")).toHaveLength(20)
    const capped = await searchProjectContent(root, "needle", { limit: 3 })
    expect(capped).toHaveLength(3)
  })

  it("returns nothing for an empty or invalid query", async () => {
    const root = await makePlainFolder()
    expect(await searchProjectContent(root, "   ")).toEqual([])
    expect(await searchProjectContent(root, 42 as unknown as string)).toEqual([])
  })
})

describe("fuzzy ranking over file paths (⌘P picker input)", () => {
  it("matches path subsequences and rejects missing letters", () => {
    expect(fuzzyScore("psearch", "src/main/surfaces/project-search.ts")).not.toBeNull()
    expect(fuzzyScore("zzz", "src/main/surfaces/project-search.ts")).toBeNull()
  })

  it("ranks a basename word-start hit above a scattered path match", () => {
    const target = fuzzyScore("fuzzy", "src/renderer/src/lib/fuzzy.ts")
    const scatter = fuzzyScore("fuzzy", "fabric/puzzle-day.md")
    expect(target).not.toBeNull()
    expect(scatter).not.toBeNull()
    expect(target as number).toBeGreaterThan(scatter as number)
  })

  it("keeps every file listed while the query is empty", () => {
    expect(fuzzyScore("", "src/anything.ts")).toBe(0)
  })
})
