import { execFile } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  getCommitDetail,
  listCommits,
  parseCommitLog,
  parseNumstat,
} from "../src/main/git"
import { splitCommitDiff } from "@renderer/lib/commit-diff"

const exec = promisify(execFile)

async function scratchRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "chat-hub-history-repo-"))
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo })
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo })
  await exec("git", ["config", "user.name", "Chat Hub Test"], { cwd: repo })
  return repo
}

const US = "\x1f"

describe("parseCommitLog", () => {
  it("reads one entry per line and splits the decorations", () => {
    const line = [
      "a".repeat(40),
      "aaaaaaa",
      "Ada Lovelace",
      "2026-08-14T10:00:00+02:00",
      "HEAD -> main, tag: v1",
      "feat: subject with ; punctuation",
    ].join(US)
    expect(parseCommitLog(line)).toEqual([
      {
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        author: "Ada Lovelace",
        date: "2026-08-14T10:00:00+02:00",
        refs: ["HEAD -> main", "tag: v1"],
        subject: "feat: subject with ; punctuation",
      },
    ])
  })

  it("drops malformed lines instead of inventing commits", () => {
    const good = ["b".repeat(40), "bbbbbbb", "A", "2026-01-01", "", "ok"].join(US)
    const out = parseCommitLog(["not a record", "", good, "x\x1fy"].join("\n"))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ subject: "ok", refs: [] })
  })

  it("returns nothing for empty output", () => {
    expect(parseCommitLog("")).toEqual([])
  })
})

describe("parseNumstat", () => {
  it("keeps line counts and flags binary rows", () => {
    const out = parseNumstat(
      ["3\t1\tsrc/a.ts", "-\t-\tlogo.png", "0\t12\tdocs/old.md", ""].join("\n"),
    )
    expect(out).toEqual([
      { path: "src/a.ts", added: 3, removed: 1, binary: false },
      { path: "logo.png", added: 0, removed: 0, binary: true },
      { path: "docs/old.md", added: 0, removed: 12, binary: false },
    ])
  })

  it("ignores garbage lines without a path column", () => {
    expect(parseNumstat("nonsense\n\n3\t")).toEqual([])
  })
})

describe("listCommits / getCommitDetail", () => {
  it("lists newest first with refs, and shows a commit's diff and stat", async () => {
    const repo = await scratchRepo()
    await writeFile(join(repo, "a.txt"), "one\n")
    await exec("git", ["add", "a.txt"], { cwd: repo })
    await exec("git", ["commit", "-qm", "first"], { cwd: repo })
    await writeFile(join(repo, "a.txt"), "one\ntwo\n")
    await writeFile(join(repo, "b.txt"), "brand new\n")
    await exec("git", ["add", "-A"], { cwd: repo })
    await exec("git", ["commit", "-qm", "second"], { cwd: repo })

    const commits = await listCommits(repo)
    expect(commits.map((c) => c.subject)).toEqual(["second", "first"])
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/)
    expect(commits[0].shortSha).toBe(commits[0].sha.slice(0, commits[0].shortSha.length))
    expect(commits[0].author).toBe("Chat Hub Test")
    expect(Date.parse(commits[0].date)).not.toBeNaN()
    expect(commits[0].refs.join(",")).toContain("main")
    expect(commits[1].refs).toEqual([])

    const detail = await getCommitDetail(repo, commits[0].sha)
    expect(detail.sha).toBe(commits[0].sha)
    expect(detail.files).toEqual([
      { path: "a.txt", added: 1, removed: 0, binary: false },
      { path: "b.txt", added: 1, removed: 0, binary: false },
    ])
    expect(detail.diff).toContain("diff --git a/a.txt b/a.txt")
    expect(detail.diff).toContain("+two")
    expect(detail.diff).toContain("+brand new")

    const files = splitCommitDiff(detail.diff)
    expect(files.map((f) => f.path)).toEqual(["a.txt", "b.txt"])
    expect(files[0].diff).toMatch(/^@@ /)
    expect(files[0].diff).not.toContain("+++")
  })

  it("treats a non-repo cwd as an empty history, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-history-plain-"))
    expect(await listCommits(dir)).toEqual([])
    expect(await getCommitDetail(dir, "abcdef1")).toEqual({
      sha: "abcdef1",
      files: [],
      diff: "",
    })
  })

  it("refuses a sha that could smuggle git options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-history-plain-"))
    await expect(getCommitDetail(dir, "--all")).rejects.toThrow(/invalid commit/i)
    await expect(getCommitDetail(dir, "HEAD")).rejects.toThrow(/invalid commit/i)
  })
})

describe("splitCommitDiff", () => {
  it("splits a multi-file show into per-file hunk blocks", () => {
    const text = [
      "diff --git a/src/x.ts b/src/x.ts",
      "index 111..222 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "diff --git a/gone.md b/gone.md",
      "deleted file mode 100644",
      "index 333..000",
      "--- a/gone.md",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
      "\\ No newline at end of file",
      "",
    ].join("\n")
    // Body lines gain the renderer's `marker SPACE content` shape, so DiffCard
    // does not eat the first character; the no-newline annotation is dropped.
    expect(splitCommitDiff(text)).toEqual([
      {
        path: "src/x.ts",
        diff: "@@ -1,2 +1,2 @@\n  keep\n- old\n+ new",
        binary: false,
      },
      {
        path: "gone.md",
        diff: "@@ -1,1 +0,0 @@\n- bye",
        binary: false,
      },
    ])
  })

  it("flags binary blocks and keeps their path from the header line", () => {
    const text = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 000..444",
      "Binary files /dev/null and b/logo.png differ",
      "",
    ].join("\n")
    expect(splitCommitDiff(text)).toEqual([
      { path: "logo.png", diff: "", binary: true },
    ])
  })

  it("returns nothing for empty or non-diff text", () => {
    expect(splitCommitDiff("")).toEqual([])
    expect(splitCommitDiff("commit abc\nAuthor: x\n")).toEqual([])
  })
})
