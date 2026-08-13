import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, sep } from "node:path"
import { homedir, tmpdir } from "node:os"
import type {
  GitBranchList,
  GitFileChange,
  GitHunkSummary,
  GitWorkingCopy,
  GitWorktreeInfo,
  GitRepository,
} from "@shared/types"

const execFileAsync = promisify(execFile)

export type SessionWorktree = {
  cwd: string
  root: string
  branch: string
  path: string
}

/** Create a clean, named branch/worktree from the repository's current HEAD. */
export async function createSessionWorktree(
  cwd: string,
  sessionId: string,
  title?: string,
): Promise<SessionWorktree> {
  const { stdout: rootOut } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd, timeout: 4000 },
  )
  const root = rootOut.trim()
  if (!root) throw new Error("The selected folder is not a Git repository")
  const slug = slugify(title || "session")
  const shortId = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)
  const branch = `chathub/${slug}-${shortId}`
  const path = join(
    homedir(),
    ".chathub",
    "worktrees",
    basename(root),
    `${slug}-${shortId}`,
  )
  await mkdir(dirname(path), { recursive: true })
  await execFileAsync(
    "git",
    ["worktree", "add", "-b", branch, path, "HEAD"],
    { cwd: root, timeout: 30_000 },
  )
  return { cwd: path, root, branch, path }
}

/** Remove an isolated worktree without discarding uncommitted user changes. */
export async function removeSessionWorktree(
  repoCwd: string,
  worktreePath: string,
): Promise<void> {
  const managedRoot = `${join(homedir(), ".chathub", "worktrees")}${sep}`
  if (!worktreePath.startsWith(managedRoot)) {
    throw new Error("Refusing to remove a worktree outside ~/.chathub/worktrees")
  }
  await execFileAsync(
    "git",
    ["worktree", "remove", worktreePath],
    { cwd: repoCwd, timeout: 30_000 },
  )
}

/** List every checkout registered with the repository, including stale entries. */
export async function listSessionWorktrees(cwd: string): Promise<GitWorktreeInfo[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd, timeout: 8000, maxBuffer: BUFFER },
  )
  const blocks = stdout.split(/\n(?=worktree )/).filter(Boolean)
  return Promise.all(
    blocks.map(async (block) => {
      const lines = block.split("\n")
      const path = lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? ""
      const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? ""
      const branchRef = lines.find((line) => line.startsWith("branch "))?.slice(7)
      const prunable = lines.some((line) => line.startsWith("prunable"))
      const bare = lines.includes("bare")
      let dirty = false
      if (path && !prunable && !bare) {
        try {
          const status = await execFileAsync(
            "git",
            ["status", "--porcelain"],
            { cwd: path, timeout: 8000, maxBuffer: BUFFER },
          )
          dirty = status.stdout.trim().length > 0
        } catch {
          dirty = true
        }
      }
      return {
        path,
        head: head.slice(0, 12),
        branch: branchRef?.replace(/^refs\/heads\//, "") ?? "(detached)",
        dirty,
        prunable,
        bare,
      }
    }),
  )
}

/** Remove stale administrative entries after a checkout directory is gone. */
export async function pruneSessionWorktrees(cwd: string): Promise<void> {
  await execFileAsync("git", ["worktree", "prune"], {
    cwd,
    timeout: 15_000,
    maxBuffer: BUFFER,
  })
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.slice(0, 42) || "session"
}

export type GitCheckoutInfo = {
  branch: string
  dirty: boolean
  root: string | null
}

/**
 * `git` refuses paths it reads as options, and a repo can legitimately hold a
 * file called `-f`, so every path argument travels after `--` and a leading
 * dash is rejected outright rather than quietly turned into a flag.
 */
function assertPathspec(path: string): string {
  if (!path || path.startsWith("-") || path.includes("\0")) {
    throw new Error(`Refusing path: ${path}`)
  }
  return path
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

export async function findGitRepositories(cwd: string): Promise<GitRepository[]> {
  const children = await readdir(cwd, { withFileTypes: true }).catch(() => [])
  const paths = [cwd, ...children.filter((d) => d.isDirectory() && !d.name.startsWith(".") && !["node_modules", "out", "release"].includes(d.name)).map((d) => join(cwd, d.name))]
  const seen = new Map<string, GitRepository>()
  for (const path of paths) { const info = await getGitCheckout(path); if (info.root) seen.set(info.root, { root: info.root, name: basename(info.root), branch: info.branch, dirty: info.dirty }) }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Initialise a repo in a folder that has none, then report its fresh state. */
export async function gitInit(cwd: string): Promise<GitCheckoutInfo> {
  await execFileAsync("git", ["init"], { cwd, timeout: 5000 })
  return getGitCheckout(cwd)
}

/** Big repos blow past execFile's 1 MB default on both status and diff. */
const BUFFER = 8 * 1024 * 1024

function parseAheadBehind(header: string): { ahead: number; behind: number } {
  const ahead = /\bahead (\d+)/.exec(header)
  const behind = /\bbehind (\d+)/.exec(header)
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
  }
}

/**
 * `-z` instead of the human format: paths with spaces, quotes or non-ASCII are
 * emitted raw, and a rename's source arrives as its own record instead of
 * inside an ` -> ` string we would have to un-escape.
 */
function parsePorcelainZ(out: string): {
  branch: string
  ahead: number
  behind: number
  files: GitFileChange[]
} {
  const records = out.split("\0")
  let branch = "HEAD"
  let ahead = 0
  let behind = 0
  const files: GitFileChange[] = []
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    if (rec.startsWith("## ")) {
      const header = rec.slice(3)
      branch = header.split(/\.\.\.| /)[0] || "HEAD"
      ;({ ahead, behind } = parseAheadBehind(header))
      continue
    }
    const index = rec[0] ?? " "
    const work = rec[1] ?? " "
    const path = rec.slice(3)
    if (!path) continue
    const renamed = index === "R" || index === "C"
    const from = renamed ? records[++i] : undefined
    files.push({ path, index, work, ...(from ? { from } : {}) })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { branch, ahead, behind, files }
}

export async function getWorkingCopy(cwd: string): Promise<GitWorkingCopy> {
  const empty: GitWorkingCopy = {
    root: null,
    branch: "no-git",
    ahead: 0,
    behind: 0,
    files: [],
  }
  try {
    const { stdout: rootOut } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 4000 },
    )
    const { stdout } = await execFileAsync(
      "git",
      [
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v1",
        "--branch",
        "-z",
        "--untracked-files=all",
      ],
      { cwd, timeout: 15_000, maxBuffer: BUFFER },
    )
    return { root: rootOut.trim() || null, ...parsePorcelainZ(stdout) }
  } catch {
    return empty
  }
}

/**
 * The diff of one path. Untracked files have no blob to diff against, so they
 * go through `--no-index` from /dev/null — which exits 1 by design, hence the
 * stdout-off-the-error read.
 */
export async function getFileDiff(
  cwd: string,
  path: string,
  staged: boolean,
  untracked = false,
): Promise<string> {
  assertPathspec(path)
  const args = untracked
    ? ["diff", "--no-color", "--no-index", "--", "/dev/null", path]
    : [
        "diff",
        "--no-color",
        ...(staged ? ["--cached"] : []),
        "--",
        path,
      ]
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 15_000,
      maxBuffer: BUFFER,
    })
    return stdout
  } catch (err) {
    const out = (err as { stdout?: string }).stdout
    if (typeof out === "string" && out.length > 0) return out
    const msg = err instanceof Error ? err.message : String(err)
    // Binary files and deleted-on-disk paths land here; say so in the pane
    // rather than leaving it blank as if the file were unchanged.
    return `# no diff available\n# ${msg.split("\n")[0]}`
  }
}

/** One hunk of a unified diff, kept verbatim so re-applying it is loss-free. */
export type FileHunk = {
  /** The full `@@ -a,b +c,d @@ …` line, byte-for-byte as git printed it. */
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Body lines, including any `\ No newline at end of file` markers. */
  lines: string[]
}

export type FilePatch = {
  /** Everything before the first hunk: `diff --git`, `index`, `---`, `+++`. */
  headerLines: string[]
  hunks: FileHunk[]
  binary: boolean
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Split one file's `git diff` output into its header and verbatim hunks.
 * Lines are kept exactly as printed — CRLF endings and no-newline markers
 * included — so a rebuilt patch is byte-identical to what git would accept.
 */
export function parseFilePatch(text: string): FilePatch {
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  const headerLines: string[] = []
  const hunks: FileHunk[] = []
  let current: FileHunk | null = null
  for (const line of lines) {
    const match = HUNK_HEADER.exec(line)
    if (match) {
      current = {
        header: line,
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current) current.lines.push(line)
    else headerLines.push(line)
  }
  const binary =
    hunks.length === 0 &&
    headerLines.some(
      (line) => line.startsWith("Binary files ") || line === "GIT binary patch",
    )
  return { headerLines, hunks, binary }
}

/**
 * A patch holding exactly one hunk of `patch`, in a shape `git apply` takes.
 * The hunk travels untouched: its old-side line numbers stay valid because the
 * base (index or HEAD) does not move when sibling hunks are left out.
 */
export function buildHunkPatch(
  patch: FilePatch,
  index: number,
): string | null {
  const hunk = patch.hunks[index]
  if (!hunk || patch.headerLines.length === 0) return null
  return [...patch.headerLines, hunk.header, ...hunk.lines].join("\n") + "\n"
}

/**
 * Hunk counts per path from a whole-repo diff. `---`/`+++` are only trusted
 * outside hunk bodies — a deleted line reading `-- x` prints as `--- x` and
 * must not be mistaken for a file header.
 */
export function countHunksByFile(diffText: string): Map<string, number> {
  const counts = new Map<string, number>()
  let oldPath: string | null = null
  let path: string | null = null
  let inHunk = false
  const headerPath = (line: string, prefix: "a/" | "b/"): string | null => {
    let raw = line.slice(4)
    if (raw.startsWith('"') && raw.endsWith('"')) {
      raw = raw
        .slice(1, -1)
        .replace(/\\([\\"tn])/g, (_, ch: string) =>
          ch === "t" ? "\t" : ch === "n" ? "\n" : ch,
        )
    }
    if (raw === "/dev/null") return null
    return raw.startsWith(prefix) ? raw.slice(2) : raw
  }
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = null
      path = null
      inHunk = false
      continue
    }
    if (HUNK_HEADER.test(line)) {
      inHunk = true
      if (path) counts.set(path, (counts.get(path) ?? 0) + 1)
      continue
    }
    if (inHunk) continue
    if (line.startsWith("--- ")) {
      oldPath = headerPath(line, "a/")
      continue
    }
    if (line.startsWith("+++ ")) {
      // A deletion diffs to /dev/null; the old side still names the file.
      path = headerPath(line, "b/") ?? oldPath
    }
  }
  return counts
}

/** Staged and unstaged hunk counts for every path with a textual diff. */
export async function getHunkSummary(cwd: string): Promise<GitHunkSummary> {
  const diffOut = (args: string[]): Promise<string> =>
    execFileAsync(
      "git",
      ["-c", "core.quotepath=false", "diff", "--no-color", ...args],
      { cwd, timeout: 15_000, maxBuffer: BUFFER },
    ).then(
      (res) => res.stdout,
      () => "",
    )
  const [worktree, index] = await Promise.all([diffOut([]), diffOut(["--cached"])])
  const summary: GitHunkSummary = {}
  for (const [path, count] of countHunksByFile(worktree)) {
    ;(summary[path] ??= { staged: 0, unstaged: 0 }).unstaged = count
  }
  for (const [path, count] of countHunksByFile(index)) {
    ;(summary[path] ??= { staged: 0, unstaged: 0 }).staged = count
  }
  return summary
}

/** Stage exactly one working-tree hunk into the index. */
export function stageFileHunk(
  cwd: string,
  path: string,
  hunkIndex: number,
  expectedHeader: string,
): Promise<{ ok: boolean; output: string }> {
  return applyFileHunk(cwd, path, hunkIndex, expectedHeader, false)
}

/** Take exactly one staged hunk back out of the index; the file keeps it. */
export function unstageFileHunk(
  cwd: string,
  path: string,
  hunkIndex: number,
  expectedHeader: string,
): Promise<{ ok: boolean; output: string }> {
  return applyFileHunk(cwd, path, hunkIndex, expectedHeader, true)
}

/**
 * The hunk is re-read from a fresh diff and matched against the header the
 * renderer saw: staging an earlier hunk shifts every later offset, so a stale
 * index+header pair must fail loudly instead of staging the wrong lines.
 */
async function applyFileHunk(
  cwd: string,
  path: string,
  hunkIndex: number,
  expectedHeader: string,
  reverse: boolean,
): Promise<{ ok: boolean; output: string }> {
  assertPathspec(path)
  try {
    const { stdout: rootOut } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 4000 },
    )
    const root = rootOut.trim()
    if (!root) return { ok: false, output: "Not a git repository" }
    const patch = parseFilePatch(await getFileDiff(root, path, reverse))
    const hunk = patch.hunks[hunkIndex]
    if (!hunk || hunk.header !== expectedHeader) {
      return {
        ok: false,
        output: "The diff changed since it was shown — hunks were refreshed, pick again",
      }
    }
    const patchText = buildHunkPatch(patch, hunkIndex)
    if (!patchText) return { ok: false, output: "No patch for this hunk" }
    const dir = await mkdtemp(join(tmpdir(), "chathub-hunk-"))
    try {
      const patchFile = join(dir, "hunk.patch")
      await writeFile(patchFile, patchText, "utf8")
      await execFileAsync(
        "git",
        ["apply", "--cached", ...(reverse ? ["-R"] : []), patchFile],
        { cwd: root, timeout: 15_000, maxBuffer: BUFFER },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    return { ok: true, output: reverse ? "Hunk unstaged" : "Hunk staged" }
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    return {
      ok: false,
      output: (e.stderr || e.message || "git apply failed").trim(),
    }
  }
}

export async function stagePaths(
  cwd: string,
  paths: string[],
): Promise<GitWorkingCopy> {
  if (paths.length > 0) {
    await execFileAsync(
      "git",
      ["add", "--", ...paths.map(assertPathspec)],
      { cwd, timeout: 30_000 },
    )
  }
  return getWorkingCopy(cwd)
}

export async function unstagePaths(
  cwd: string,
  paths: string[],
): Promise<GitWorkingCopy> {
  if (paths.length > 0) {
    // `reset -q HEAD --` rather than `restore --staged`: it is the one that
    // also works before the first commit, where HEAD does not resolve yet.
    await execFileAsync(
      "git",
      ["reset", "-q", "HEAD", "--", ...paths.map(assertPathspec)],
      { cwd, timeout: 30_000 },
    ).catch(async () => {
      await execFileAsync(
        "git",
        ["rm", "--cached", "-q", "--", ...paths.map(assertPathspec)],
        { cwd, timeout: 30_000 },
      )
    })
  }
  return getWorkingCopy(cwd)
}

export async function listBranches(cwd: string): Promise<GitBranchList> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      { cwd, timeout: 8000, maxBuffer: BUFFER },
    )
    const { stdout: head } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, timeout: 4000 },
    )
    return {
      current: head.trim() || "HEAD",
      branches: stdout.split("\n").filter(Boolean),
    }
  } catch {
    return { current: "no-git", branches: [] }
  }
}

/**
 * Plain `git checkout`, so a switch that would drop uncommitted work fails with
 * git's own message instead of us deciding to stash or discard it for the user.
 */
export async function checkoutBranch(
  cwd: string,
  branch: string,
): Promise<{ ok: boolean; output: string }> {
  if (!branch || branch.startsWith("-")) throw new Error("Invalid branch")
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["checkout", branch],
      { cwd, timeout: 30_000 },
    )
    return { ok: true, output: (stderr || stdout || `on ${branch}`).trim() }
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    return { ok: false, output: (e.stderr || e.message || "").trim() }
  }
}

/** Commits what the user staged in the panel — never an implicit `add -A`. */
export async function gitCommitStaged(
  cwd: string,
  message: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["commit", "-m", message],
      { cwd, timeout: 30_000 },
    )
    return { ok: true, output: (stdout || stderr || "committed").trim() }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      output: (e.stdout || e.stderr || e.message || "commit failed").trim(),
    }
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

/** Push the current branch explicitly; never force-push or infer a remote. */
export async function gitPush(
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["push", "--set-upstream", "origin", "HEAD"],
      { cwd, timeout: 120_000, maxBuffer: BUFFER },
    )
    return { ok: true, output: (stdout || stderr || "pushed").trim() }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      output: (e.stderr || e.stdout || e.message || "push failed").trim(),
    }
  }
}

/** Create a PR through the installed GitHub CLI, with no shell interpolation. */
export async function gitCreatePr(
  cwd: string,
  title: string,
  body: string,
  draft: boolean,
): Promise<{ ok: boolean; output: string }> {
  if (!title.trim()) throw new Error("PR title required")
  try {
    const prBody = body.trim() || (await buildPrBody(cwd))
    const args = ["pr", "create", "--title", title.trim(), "--body", prBody]
    if (draft) args.push("--draft")
    const { stdout, stderr } = await execFileAsync("gh", args, {
      cwd,
      timeout: 120_000,
      maxBuffer: BUFFER,
    })
    return { ok: true, output: (stdout || stderr || "PR created").trim() }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      output: (e.stderr || e.stdout || e.message || "PR creation failed").trim(),
    }
  }
}

/** Build a useful PR body when the user leaves the optional body empty. */
export async function buildPrBody(cwd: string): Promise<string> {
  const [log, stat, status] = await Promise.all([
    execFileAsync("git", ["log", "-8", "--pretty=format:- %s"], {
      cwd,
      timeout: 8000,
      maxBuffer: BUFFER,
    }),
    execFileAsync("git", ["diff", "--stat", "HEAD~1..HEAD"], {
      cwd,
      timeout: 8000,
      maxBuffer: BUFFER,
    }).catch(() =>
      execFileAsync("git", ["show", "--stat", "--oneline", "--format=", "HEAD"], {
        cwd,
        timeout: 8000,
        maxBuffer: BUFFER,
      }).catch(() => ({ stdout: "", stderr: "" })),
    ),
    execFileAsync("git", ["status", "--short"], {
      cwd,
      timeout: 8000,
      maxBuffer: BUFFER,
    }),
  ])
  const commits = log.stdout.trim() || "- No local commits found"
  const files = stat.stdout.trim() || "No commit diff available"
  const workingTree = status.stdout.trim() || "Clean"
  return [
    "## Summary",
    "",
    commits,
    "",
    "## Diff",
    "",
    "```text",
    files,
    "```",
    "",
    "## Working tree",
    "",
    `\`${workingTree}\``,
  ].join("\n")
}
