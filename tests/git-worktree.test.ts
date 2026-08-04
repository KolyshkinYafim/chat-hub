import { execFile } from "node:child_process"
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createSessionWorktree, removeSessionWorktree } from "../src/main/git"

const exec = promisify(execFile)

describe("session worktrees", () => {
  it("creates an isolated branch from HEAD and removes it cleanly", async () => {
    const repo = await mkdtemp(join(tmpdir(), "chat-hub-worktree-repo-"))
    await exec("git", ["init", "-q"], { cwd: repo })
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo })
    await exec("git", ["config", "user.name", "Chat Hub Test"], { cwd: repo })
    await writeFile(join(repo, "README.md"), "base\n")
    await exec("git", ["add", "README.md"], { cwd: repo })
    await exec("git", ["commit", "-qm", "initial"], { cwd: repo })

    const result = await createSessionWorktree(repo, "12345678-session", "Fix API retries")
    expect(result.branch).toMatch(/^chathub\/fix-api-retries-/)
    expect(result.root).toBe(await realpath(repo))
    expect(await readFile(join(result.cwd, "README.md"), "utf8")).toBe("base\n")

    await removeSessionWorktree(repo, result.path)
    await expect(readFile(result.path)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
