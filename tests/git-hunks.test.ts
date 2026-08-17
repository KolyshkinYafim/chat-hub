import { execFile } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildHunkPatch,
  countHunksByFile,
  getFileDiff,
  getHunkSummary,
  hunkText,
  parseFilePatch,
  stageFileHunk,
  unstageFileHunk,
} from "../src/main/git"

const exec = promisify(execFile)

const TWO_HUNKS = [
  "diff --git a/notes.txt b/notes.txt",
  "index 0000000..1111111 100644",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@ -1,3 +1,3 @@",
  "-alpha",
  "+ALPHA",
  " bravo",
  " charlie",
  "@@ -9,3 +9,4 @@ context tail",
  " india",
  "-juliet",
  "+JULIET",
  "+added",
  " kilo",
  "",
].join("\n")

describe("parseFilePatch", () => {
  it("splits header lines from verbatim hunks", () => {
    const patch = parseFilePatch(TWO_HUNKS)
    expect(patch.binary).toBe(false)
    expect(patch.headerLines).toEqual([
      "diff --git a/notes.txt b/notes.txt",
      "index 0000000..1111111 100644",
      "--- a/notes.txt",
      "+++ b/notes.txt",
    ])
    expect(patch.hunks).toHaveLength(2)
    expect(patch.hunks[0]).toMatchObject({
      header: "@@ -1,3 +1,3 @@",
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 3,
    })
    expect(patch.hunks[1]).toMatchObject({
      header: "@@ -9,3 +9,4 @@ context tail",
      oldStart: 9,
      newCount: 4,
    })
    expect(patch.hunks[1]!.lines).toEqual([
      " india",
      "-juliet",
      "+JULIET",
      "+added",
      " kilo",
    ])
  })

  it("reads single-line hunks whose counts are omitted", () => {
    const patch = parseFilePatch(
      ["--- a/x", "+++ b/x", "@@ -3 +3 @@", "-old", "+new", ""].join("\n"),
    )
    expect(patch.hunks[0]).toMatchObject({
      oldStart: 3,
      oldCount: 1,
      newStart: 3,
      newCount: 1,
    })
  })

  it("keeps adjacent hunks apart and verbatim", () => {
    const patch = parseFilePatch(
      [
        "--- a/x",
        "+++ b/x",
        "@@ -1,4 +1,4 @@",
        "-a1",
        "+A1",
        " a2",
        " a3",
        " a4",
        "@@ -5,4 +5,4 @@",
        " b1",
        " b2",
        " b3",
        "-b4",
        "+B4",
        "",
      ].join("\n"),
    )
    expect(patch.hunks).toHaveLength(2)
    expect(patch.hunks[0]!.lines).toEqual(["-a1", "+A1", " a2", " a3", " a4"])
    expect(patch.hunks[1]!.lines).toEqual([" b1", " b2", " b3", "-b4", "+B4"])
  })

  it("carries no-newline markers on either side of a hunk", () => {
    const patch = parseFilePatch(
      [
        "--- a/x",
        "+++ b/x",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-omega",
        "\\ No newline at end of file",
        "+omega!",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    )
    expect(patch.hunks[0]!.lines).toEqual([
      " alpha",
      "-omega",
      "\\ No newline at end of file",
      "+omega!",
      "\\ No newline at end of file",
    ])
  })

  it("preserves CRLF line bodies untouched", () => {
    const patch = parseFilePatch(
      "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-one\r\n+ONE\r\n two\r\n",
    )
    expect(patch.hunks[0]!.lines).toEqual(["-one\r", "+ONE\r", " two\r"])
  })

  it("flags binary diffs and yields no hunks for them", () => {
    const patch = parseFilePatch(
      [
        "diff --git a/logo.png b/logo.png",
        "index 123..456 100644",
        "Binary files a/logo.png and b/logo.png differ",
        "",
      ].join("\n"),
    )
    expect(patch.binary).toBe(true)
    expect(patch.hunks).toEqual([])
  })

  it("treats the no-diff placeholder as plain hunkless text", () => {
    const patch = parseFilePatch("# no diff available\n# something\n")
    expect(patch.binary).toBe(false)
    expect(patch.hunks).toEqual([])
  })
})

describe("buildHunkPatch", () => {
  it("emits the file header plus exactly one hunk", () => {
    const patch = parseFilePatch(TWO_HUNKS)
    expect(buildHunkPatch(patch, 1)).toBe(
      [
        "diff --git a/notes.txt b/notes.txt",
        "index 0000000..1111111 100644",
        "--- a/notes.txt",
        "+++ b/notes.txt",
        "@@ -9,3 +9,4 @@ context tail",
        " india",
        "-juliet",
        "+JULIET",
        "+added",
        " kilo",
        "",
      ].join("\n"),
    )
    expect(buildHunkPatch(patch, 0)).not.toContain("JULIET")
  })

  it("keeps CRLF and no-newline markers in the built patch", () => {
    const patch = parseFilePatch(
      "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-one\r\n+ONE\r\n\\ No newline at end of file\n",
    )
    expect(buildHunkPatch(patch, 0)).toBe(
      "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-one\r\n+ONE\r\n\\ No newline at end of file\n",
    )
  })

  it("returns null for a missing hunk or a headerless patch", () => {
    const patch = parseFilePatch(TWO_HUNKS)
    expect(buildHunkPatch(patch, 2)).toBeNull()
    expect(buildHunkPatch(parseFilePatch(""), 0)).toBeNull()
  })
})

describe("countHunksByFile", () => {
  it("attributes hunks across files, deletions, creations and quoting", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 111..222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      "-const a = 1",
      "+const a = 2",
      " const b = 3",
      "@@ -10,3 +10,2 @@",
      " keep",
      "--- tricky",
      " tail",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 333..000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-x",
      "-y",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 000..444",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      'diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"',
      "index 555..666 100644",
      '--- "a/tab\\tname.txt"',
      '+++ "b/tab\\tname.txt"',
      "@@ -1 +1 @@",
      "-t1",
      "+t2",
      "",
    ].join("\n")
    const counts = countHunksByFile(diff)
    expect(counts.get("src/app.ts")).toBe(2)
    expect(counts.get("gone.txt")).toBe(1)
    expect(counts.get("new.txt")).toBe(1)
    expect(counts.get("tab\tname.txt")).toBe(1)
    // The `--- tricky` deletion inside a hunk body must not become a file.
    expect(counts.size).toBe(4)
  })

  it("counts nothing for binary-only diffs", () => {
    const counts = countHunksByFile(
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
    )
    expect(counts.size).toBe(0)
  })
})

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "chat-hub-hunk-repo-"))
  await exec("git", ["init", "-q"], { cwd: repo })
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo })
  await exec("git", ["config", "user.name", "Chat Hub Test"], { cwd: repo })
  await exec("git", ["config", "core.autocrlf", "false"], { cwd: repo })
  return repo
}

async function commitFile(
  repo: string,
  name: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(repo, name), content)
  await exec("git", ["add", name], { cwd: repo })
  await exec("git", ["commit", "-qm", message], { cwd: repo })
}

const BASE = Array.from(
  { length: 12 },
  (_, i) => `line${String(i + 1).padStart(2, "0")}`,
).join("\n") + "\n"

describe("per-hunk staging against a real repository", () => {
  it("stages one of two hunks; the commit carries exactly that hunk", async () => {
    const repo = await initRepo()
    await commitFile(repo, "notes.txt", BASE, "base")
    const edited = BASE.replace("line02", "line02 changed").replace(
      "line11",
      "line11 changed",
    )
    await writeFile(join(repo, "notes.txt"), edited)

    const patch = parseFilePatch(await getFileDiff(repo, "notes.txt", false))
    expect(patch.hunks).toHaveLength(2)

    const res = await stageFileHunk(repo, "notes.txt", 0, hunkText(patch.hunks[0]!))
    expect(res).toMatchObject({ ok: true })

    expect(await getHunkSummary(repo)).toEqual({
      "notes.txt": { staged: 1, unstaged: 1 },
    })

    await exec("git", ["commit", "-qm", "first hunk"], { cwd: repo })
    const { stdout: committed } = await exec(
      "git",
      ["show", "HEAD:notes.txt"],
      { cwd: repo },
    )
    expect(committed).toBe(BASE.replace("line02", "line02 changed"))

    // The second hunk stayed in the working tree, untouched and unstaged.
    const rest = parseFilePatch(await getFileDiff(repo, "notes.txt", false))
    expect(rest.hunks).toHaveLength(1)
    expect(rest.hunks[0]!.lines).toContain("+line11 changed")
    expect(await readFile(join(repo, "notes.txt"), "utf8")).toBe(edited)
  })

  it("rejects stale hunk indexes and headers after an earlier apply shifted offsets", async () => {
    const repo = await initRepo()
    await commitFile(repo, "notes.txt", BASE, "base")
    // The first hunk adds a line, so every later hunk's header moves.
    const edited = BASE.replace("line02\n", "line02\nline02b\n").replace(
      "line11",
      "line11 changed",
    )
    await writeFile(join(repo, "notes.txt"), edited)

    const before = parseFilePatch(await getFileDiff(repo, "notes.txt", false))
    expect(before.hunks).toHaveLength(2)
    const staleSecond = before.hunks[1]!

    expect(
      await stageFileHunk(repo, "notes.txt", 0, hunkText(before.hunks[0]!)),
    ).toMatchObject({ ok: true })

    // Old index: that hunk no longer exists in the fresh diff.
    const byIndex = await stageFileHunk(repo, "notes.txt", 1, hunkText(staleSecond))
    expect(byIndex.ok).toBe(false)
    expect(byIndex.output).toMatch(/changed since/i)
    // Old header on the surviving hunk: offsets shifted, must not apply.
    const byHeader = await stageFileHunk(repo, "notes.txt", 0, hunkText(staleSecond))
    expect(byHeader.ok).toBe(false)

    // The honest path: re-read the diff, then the second hunk stages cleanly.
    const fresh = parseFilePatch(await getFileDiff(repo, "notes.txt", false))
    expect(fresh.hunks).toHaveLength(1)
    expect(fresh.hunks[0]!.header).not.toBe(staleSecond.header)
    expect(
      await stageFileHunk(repo, "notes.txt", 0, hunkText(fresh.hunks[0]!)),
    ).toMatchObject({ ok: true })
    const { stdout: unstagedLeft } = await exec("git", ["diff"], { cwd: repo })
    expect(unstagedLeft).toBe("")
  })

  it("unstages a single hunk while the working tree keeps the change", async () => {
    const repo = await initRepo()
    await commitFile(repo, "notes.txt", BASE, "base")
    const edited = BASE.replace("line02", "line02 changed").replace(
      "line11",
      "line11 changed",
    )
    await writeFile(join(repo, "notes.txt"), edited)
    await exec("git", ["add", "notes.txt"], { cwd: repo })

    const staged = parseFilePatch(await getFileDiff(repo, "notes.txt", true))
    expect(staged.hunks).toHaveLength(2)
    const res = await unstageFileHunk(
      repo,
      "notes.txt",
      0,
      hunkText(staged.hunks[0]!),
    )
    expect(res).toMatchObject({ ok: true })

    expect(await getHunkSummary(repo)).toEqual({
      "notes.txt": { staged: 1, unstaged: 1 },
    })
    const left = parseFilePatch(await getFileDiff(repo, "notes.txt", true))
    expect(left.hunks).toHaveLength(1)
    expect(left.hunks[0]!.lines).toContain("+line11 changed")
    expect(await readFile(join(repo, "notes.txt"), "utf8")).toBe(edited)
  })

  it("stages a hunk that ends without a trailing newline", async () => {
    const repo = await initRepo()
    await commitFile(repo, "no-eol.txt", "alpha\nomega", "base")
    await writeFile(join(repo, "no-eol.txt"), "alpha\nomega!")

    const patch = parseFilePatch(await getFileDiff(repo, "no-eol.txt", false))
    expect(patch.hunks).toHaveLength(1)
    expect(patch.hunks[0]!.lines).toContain("\\ No newline at end of file")

    const res = await stageFileHunk(repo, "no-eol.txt", 0, hunkText(patch.hunks[0]!))
    expect(res).toMatchObject({ ok: true })
    const { stdout: indexed } = await exec("git", ["show", ":no-eol.txt"], {
      cwd: repo,
    })
    expect(indexed).toBe("alpha\nomega!")
  })

  it("rejects a hunk whose content changed on disk under an unchanged header", async () => {
    const repo = await initRepo()
    await commitFile(repo, "notes.txt", BASE, "base")
    await writeFile(join(repo, "notes.txt"), BASE.replace("line02", "line02 REVIEWED"))
    const reviewed = parseFilePatch(await getFileDiff(repo, "notes.txt", false))
    expect(reviewed.hunks).toHaveLength(1)

    // An agent overwrites the file between render and click. Same position,
    // same line counts — the `@@` header alone cannot tell the difference,
    // and nothing the user never saw may pass the review gate.
    await writeFile(join(repo, "notes.txt"), BASE.replace("line02", "line02 MALICIOUS"))
    const fresh = parseFilePatch(await getFileDiff(repo, "notes.txt", false))
    expect(fresh.hunks[0]!.header).toBe(reviewed.hunks[0]!.header)

    const res = await stageFileHunk(
      repo,
      "notes.txt",
      0,
      hunkText(reviewed.hunks[0]!),
    )
    expect(res.ok).toBe(false)
    expect(res.output).toMatch(/changed since/i)
    const { stdout: staged } = await exec("git", ["diff", "--cached"], {
      cwd: repo,
    })
    expect(staged).toBe("")
  })

  it("stages and counts hunks despite hostile user diff.* config", async () => {
    const repo = await initRepo()
    await commitFile(repo, "notes.txt", BASE, "base")
    // Each of these breaks a naive `git diff | git apply` round-trip: an
    // external tool emits no hunks at all, prefix changes break `-p1` and
    // path keys, and zero context makes `apply --cached` refuse the patch.
    await exec("git", ["config", "diff.external", "false"], { cwd: repo })
    await exec("git", ["config", "diff.noprefix", "true"], { cwd: repo })
    await exec("git", ["config", "diff.mnemonicPrefix", "true"], { cwd: repo })
    await exec("git", ["config", "diff.context", "0"], { cwd: repo })
    const edited = BASE.replace("line02", "line02 changed").replace(
      "line11",
      "line11 changed",
    )
    await writeFile(join(repo, "notes.txt"), edited)

    const patch = parseFilePatch(await getFileDiff(repo, "notes.txt", false))
    expect(patch.headerLines).toContain("--- a/notes.txt")
    expect(patch.hunks).toHaveLength(2)

    const res = await stageFileHunk(
      repo,
      "notes.txt",
      0,
      hunkText(patch.hunks[0]!),
    )
    expect(res).toMatchObject({ ok: true })
    expect(await getHunkSummary(repo)).toEqual({
      "notes.txt": { staged: 1, unstaged: 1 },
    })
  })

  it("stages a hunk of CRLF content byte-for-byte", async () => {
    const repo = await initRepo()
    await commitFile(repo, "crlf.txt", "one\r\ntwo\r\nthree\r\n", "base")
    await writeFile(join(repo, "crlf.txt"), "one\r\nTWO\r\nthree\r\n")

    const patch = parseFilePatch(await getFileDiff(repo, "crlf.txt", false))
    expect(patch.hunks).toHaveLength(1)
    expect(patch.hunks[0]!.lines).toContain("+TWO\r")

    const res = await stageFileHunk(repo, "crlf.txt", 0, hunkText(patch.hunks[0]!))
    expect(res).toMatchObject({ ok: true })
    const { stdout: indexed } = await exec("git", ["show", ":crlf.txt"], {
      cwd: repo,
    })
    expect(indexed).toBe("one\r\nTWO\r\nthree\r\n")
  })
})

describe("getHunkSummary", () => {
  it("rejects when the diff cannot be read, never resolving empty", async () => {
    // The counts back the publish-gate warning; a failure that resolved to {}
    // would be indistinguishable from "everything is staged".
    const dir = await mkdtemp(join(tmpdir(), "chat-hub-no-repo-"))
    await expect(getHunkSummary(dir)).rejects.toThrow()
  })
})
