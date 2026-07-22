import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type GitCheckoutInfo = {
  branch: string
  dirty: boolean
  root: string | null
}

export async function getGitCheckout(cwd: string): Promise<GitCheckoutInfo> {
  try {
    const { stdout: rootOut } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 4000 },
    )
    const root = rootOut.trim() || null
    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 4000 },
    )
    const branch = branchOut.trim() || "HEAD"
    const { stdout: statusOut } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd, timeout: 5000 },
    )
    return {
      branch,
      dirty: statusOut.trim().length > 0,
      root,
    }
  } catch {
    return { branch: "no-git", dirty: false, root: null }
  }
}

export async function gitCommitAll(
  cwd: string,
  message: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    await execFileAsync("git", ["add", "-A"], { cwd, timeout: 15_000 })
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["commit", "-m", message],
      { cwd, timeout: 30_000 },
    )
    return { ok: true, output: (stdout || stderr || "committed").trim() }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, output: msg }
  }
}
