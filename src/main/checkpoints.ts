import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveContainedPath, SurfacePathError } from "./surfaces/paths"

const execFileAsync = promisify(execFile)

const BUFFER = 8 * 1024 * 1024

const REF_ROOT = "refs/chathub/checkpoints"

const REF_CLAIM_ATTEMPTS = 8

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Chat Hub",
  GIT_AUTHOR_EMAIL: "checkpoints@chathub.local",
  GIT_COMMITTER_NAME: "Chat Hub",
  GIT_COMMITTER_EMAIL: "checkpoints@chathub.local",
} as const

export type CheckpointInfo = {
  ref: string
  label: string
  createdAt: number
}

function refPrefix(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, "")
  if (!safe) throw new Error(`Invalid session id: ${sessionId}`)
  return `${REF_ROOT}/${safe}`
}

async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 4000 },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function headCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      { cwd: root, timeout: 4000 },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Every index operation here runs against a throwaway index file, so a
 * snapshot or revert never moves what the user has staged in the real one.
 */
async function withTempIndex<T>(
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "chathub-checkpoint-"))
  try {
    return await fn({ ...process.env, GIT_INDEX_FILE: join(dir, "index") })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeWorkingTree(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<{ tree: string; head: string | null }> {
  const head = await headCommit(root)
  if (head) {
    await execFileAsync("git", ["read-tree", head], {
      cwd: root,
      env,
      timeout: 15_000,
    })
  }
  await execFileAsync("git", ["add", "-A"], {
    cwd: root,
    env,
    timeout: 60_000,
    maxBuffer: BUFFER,
  })
  const { stdout } = await execFileAsync("git", ["write-tree"], {
    cwd: root,
    env,
    timeout: 15_000,
  })
  return { tree: stdout.trim(), head }
}

type RefEntry = CheckpointInfo & { n: number }

async function listRefs(root: string, prefix: string): Promise<RefEntry[]> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "for-each-ref",
      `${prefix}/`,
      "--format=%(refname)%1f%(committerdate:unix)%1f%(subject)",
    ],
    { cwd: root, timeout: 8000, maxBuffer: BUFFER },
  )
  const entries: RefEntry[] = []
  for (const line of stdout.split("\n")) {
    const [ref, date, label] = line.split("\x1f")
    if (!ref || !ref.startsWith(`${prefix}/`)) continue
    const n = Number(ref.slice(prefix.length + 1))
    if (!Number.isInteger(n)) continue
    entries.push({
      ref,
      n,
      label: label ?? "",
      createdAt: (Number(date) || 0) * 1000,
    })
  }
  entries.sort((a, b) => a.n - b.n)
  return entries
}

export async function createCheckpoint(
  cwd: string,
  sessionId: string,
  label: string,
): Promise<CheckpointInfo | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  const prefix = refPrefix(sessionId)
  return withTempIndex(async (env) => {
    const { tree, head } = await writeWorkingTree(root, env)
    const message = label.trim().split("\n")[0]?.slice(0, 120) || "checkpoint"
    const { stdout: commitOut } = await execFileAsync(
      "git",
      ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message],
      { cwd: root, env: { ...env, ...IDENTITY_ENV }, timeout: 15_000 },
    )
    const ref = await claimRef(root, prefix, commitOut.trim())
    return { ref, label: message, createdAt: Date.now() }
  })
}

/**
 * An empty old-value makes `update-ref` refuse an existing ref, so two
 * checkpoints racing for one session retry onto a free number instead of
 * silently overwriting a snapshot that nothing else can recover.
 */
async function claimRef(
  root: string,
  prefix: string,
  commit: string,
): Promise<string> {
  for (let attempt = 0; attempt < REF_CLAIM_ATTEMPTS; attempt += 1) {
    const existing = await listRefs(root, prefix)
    const ref = `${prefix}/${(existing[existing.length - 1]?.n ?? 0) + 1}`
    try {
      await execFileAsync("git", ["update-ref", ref, commit, ""], {
        cwd: root,
        timeout: 8000,
      })
      return ref
    } catch {
      continue
    }
  }
  throw new Error("Could not claim a checkpoint ref")
}

export async function listCheckpoints(
  cwd: string,
  sessionId: string,
): Promise<CheckpointInfo[]> {
  const root = await repoRoot(cwd)
  if (!root) return []
  const entries = await listRefs(root, refPrefix(sessionId))
  return entries.map(({ ref, label, createdAt }) => ({ ref, label, createdAt }))
}

function parseDeletedPaths(diffOut: string): string[] {
  const records = diffOut.split("\0")
  const doomed: string[] = []
  for (let i = 0; i + 1 < records.length; i += 2) {
    const status = records[i]
    const path = records[i + 1]
    if (status?.startsWith("D") && path) doomed.push(path)
  }
  return doomed
}

/**
 * Restore the working tree to a checkpoint's snapshot: rewrite every file the
 * snapshot holds and delete files created since — nothing outside the repo
 * root is ever touched, and the user's real index is left alone.
 */
export async function revertToCheckpoint(
  cwd: string,
  sessionId: string,
  ref: string,
): Promise<void> {
  const root = await repoRoot(cwd)
  if (!root) throw new Error("Not a git repository")
  const prefix = refPrefix(sessionId)
  const suffix = ref.startsWith(`${prefix}/`) ? ref.slice(prefix.length + 1) : ""
  if (!/^\d+$/.test(suffix)) {
    throw new Error(`Not a checkpoint of this session: ${ref}`)
  }
  let snapshot: string
  try {
    const { stdout: shaOut } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", `${ref}^{commit}`],
      { cwd: root, timeout: 4000 },
    )
    snapshot = shaOut.trim()
  } catch {
    throw new Error(
      "This checkpoint has been pruned — only the newest 20 per session are kept.",
    )
  }

  const currentTree = await withTempIndex(async (env) => {
    const { tree } = await writeWorkingTree(root, env)
    return tree
  })
  const { stdout: diffOut } = await execFileAsync(
    "git",
    [
      "diff-tree",
      "-r",
      "-z",
      "--name-status",
      "--no-renames",
      currentTree,
      snapshot,
    ],
    { cwd: root, timeout: 15_000, maxBuffer: BUFFER },
  )
  const doomed = parseDeletedPaths(diffOut)

  await withTempIndex(async (env) => {
    await execFileAsync("git", ["read-tree", snapshot], {
      cwd: root,
      env,
      timeout: 15_000,
    })
    await execFileAsync("git", ["checkout-index", "-a", "-f"], {
      cwd: root,
      env,
      timeout: 60_000,
      maxBuffer: BUFFER,
    })
  })

  for (const rel of doomed) {
    let absolutePath: string
    try {
      ;({ absolutePath } = resolveContainedPath(root, rel))
    } catch (err) {
      if (err instanceof SurfacePathError) continue
      throw err
    }
    await rm(absolutePath, { force: true }).catch(() => undefined)
  }
}

export async function pruneCheckpoints(
  cwd: string,
  sessionId: string,
  keep: number,
): Promise<void> {
  const root = await repoRoot(cwd)
  if (!root) return
  const entries = await listRefs(root, refPrefix(sessionId))
  const excess = entries.slice(0, Math.max(0, entries.length - keep))
  for (const entry of excess) {
    await execFileAsync("git", ["update-ref", "-d", entry.ref], {
      cwd: root,
      timeout: 8000,
    })
  }
}

export async function deleteSessionCheckpoints(
  cwd: string,
  sessionId: string,
): Promise<void> {
  await pruneCheckpoints(cwd, sessionId, 0)
}
