import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildPrBody,
  createSessionWorktree,
  listSessionWorktrees,
  removeSessionWorktree,
} from "../src/main/git"

const exec = promisify(execFile)

describe("session worktrees", () => {
  // Spawns a dozen git subprocesses; under a full-suite run they compete for
  // CPU/disk with 50+ parallel test files, so the default 5s timeout flakes.
  it("creates an isolated branch from HEAD and removes it cleanly", { timeout: 30_000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), "chat-hub-worktree-repo-"))
    await exec("git", ["init", "-q"], { cwd: repo })
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo })
    await exec("git", ["config", "user.name", "Chat Hub Test"], { cwd: repo })
    await writeFile(join(repo, "README.md"), "base\n")
    await exec("git", ["add", "README.md"], { cwd: repo })
    await exec("git", ["commit", "-qm", "initial"], { cwd: repo })

    const body = await buildPrBody(repo)
    expect(body).toContain("- initial")
    expect(body).toContain("README.md")
    expect(body).toContain("## Working tree")

    const result = await createSessionWorktree(repo, "12345678-session", "Fix API retries")
    expect(result.branch).toMatch(/^chathub\/fix-api-retries-/)
    expect(result.root).toBe(await realpath(repo))
    expect(await readFile(join(result.cwd, "README.md"), "utf8")).toBe("base\n")

    await writeFile(join(result.cwd, "scratch.txt"), "uncommitted\n")
    const worktrees = await listSessionWorktrees(repo)
    const listed = worktrees.find((worktree) => worktree.path === result.path)
    expect(worktrees).toHaveLength(2)
    expect(listed).toMatchObject({
      branch: result.branch,
      dirty: true,
      prunable: false,
      bare: false,
    })
    await unlink(join(result.cwd, "scratch.txt"))

    await expect(removeSessionWorktree(repo, repo)).rejects.toThrow(/outside/i)

    await removeSessionWorktree(repo, result.path)
    await expect(readFile(result.path)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
