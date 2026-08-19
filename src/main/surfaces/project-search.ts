import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { open, readdir, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import {
  BINARY_SNIFF_BYTES,
  FILE_READ_LIMIT_BYTES,
  HIDDEN_FROM_LISTING,
  PROJECT_FILE_LIST_LIMIT,
  PROJECT_SEARCH_EXCERPT_CHARS,
  PROJECT_SEARCH_LIMIT,
  PROJECT_SEARCH_PER_FILE_LIMIT,
  type ProjectSearchHit,
} from "@shared/surfaces"
import { resolveWorkspaceRoot } from "./paths"

const execFileAsync = promisify(execFile)

const BUFFER = 8 * 1024 * 1024

const SKIPPED_NAMES = new Set(HIDDEN_FROM_LISTING)

function clampLimit(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(Math.floor(value), ceiling))
}

async function gitListFiles(root: string, limit: number): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, timeout: 15_000, maxBuffer: BUFFER },
    )
    return stdout.split("\0").filter(Boolean).slice(0, limit)
  } catch {
    return null
  }
}

async function walkFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = []
  const queue: string[] = [""]
  while (queue.length > 0 && files.length < limit) {
    const rel = queue.shift() as string
    const dirents = await readdir(join(root, rel), { withFileTypes: true }).catch(
      () => [],
    )
    for (const dirent of dirents) {
      if (files.length >= limit) break
      if (SKIPPED_NAMES.has(dirent.name)) continue
      const path = rel ? `${rel}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        if (!dirent.name.startsWith(".")) queue.push(path)
        continue
      }
      if (dirent.isFile()) files.push(path)
    }
  }
  files.sort()
  return files
}

/**
 * Workspace-relative paths of every file worth listing: `git ls-files
 * --cached --others --exclude-standard` in a checkout (respects .gitignore,
 * includes untracked), a hidden-dir-skipping walk everywhere else.
 */
export async function listProjectFiles(
  cwd: unknown,
  limit: unknown = PROJECT_FILE_LIST_LIMIT,
): Promise<string[]> {
  const root = resolveWorkspaceRoot(cwd)
  const cap = clampLimit(limit, PROJECT_FILE_LIST_LIMIT, PROJECT_FILE_LIST_LIMIT)
  const fromGit = await gitListFiles(root, cap)
  if (fromGit !== null) return fromGit
  return walkFiles(root, cap)
}

function excerptOf(line: string): string {
  const cleaned = line.replace(/\r$/, "").trimStart()
  return cleaned.length > PROJECT_SEARCH_EXCERPT_CHARS
    ? cleaned.slice(0, PROJECT_SEARCH_EXCERPT_CHARS)
    : cleaned
}

function parseGrepRecords(out: string, limit: number): ProjectSearchHit[] {
  const hits: ProjectSearchHit[] = []
  const perFile = new Map<string, number>()
  for (const record of out.split("\n")) {
    if (hits.length >= limit) break
    if (!record) continue
    const [path, lineNo, ...rest] = record.split("\0")
    if (!path || lineNo === undefined || rest.length === 0) continue
    const line = Number(lineNo)
    if (!Number.isInteger(line) || line < 1) continue
    const seen = perFile.get(path) ?? 0
    if (seen >= PROJECT_SEARCH_PER_FILE_LIMIT) continue
    perFile.set(path, seen + 1)
    hits.push({ path, line, text: excerptOf(rest.join("\0")) })
  }
  return hits
}

async function gitGrep(
  root: string,
  query: string,
  limit: number,
): Promise<ProjectSearchHit[] | null> {
  const args = [
    "grep",
    "-z",
    "-n",
    "-I",
    "--untracked",
    "--ignore-case",
    "-F",
    "-e",
    query,
    "--",
    ".",
  ]
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      timeout: 15_000,
      maxBuffer: BUFFER,
    })
    return parseGrepRecords(stdout, limit)
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string }
    if (e.code === 1) return parseGrepRecords(e.stdout ?? "", limit)
    return null
  }
}

async function readTextHead(absolutePath: string): Promise<string | null> {
  let handle: FileHandle
  try {
    handle = await open(absolutePath, "r")
  } catch {
    return null
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) return null
    const wanted = Math.min(stats.size, FILE_READ_LIMIT_BYTES)
    const buffer = Buffer.alloc(wanted)
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null
    return bytes.toString("utf8")
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function scanFiles(
  root: string,
  query: string,
  limit: number,
): Promise<ProjectSearchHit[]> {
  const needle = query.toLowerCase()
  const files = await walkFiles(root, PROJECT_FILE_LIST_LIMIT)
  const hits: ProjectSearchHit[] = []
  for (const path of files) {
    if (hits.length >= limit) break
    const text = await readTextHead(join(root, path))
    if (text === null) continue
    const lines = text.split("\n")
    let inFile = 0
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue
      hits.push({ path, line: i + 1, text: excerptOf(lines[i]) })
      inFile += 1
      if (inFile >= PROJECT_SEARCH_PER_FILE_LIMIT || hits.length >= limit) break
    }
  }
  return hits
}

/**
 * Case-insensitive fixed-string content search: `git grep -z -n -I
 * --untracked --ignore-case -F` in a checkout (flag set verified against git
 * 2.50.1; exit 1 with empty stderr is "no matches", not failure), a
 * binary-skipping scan elsewhere. Capped per file and in total; a file that
 * vanishes mid-scan is skipped, never thrown on.
 */
export async function searchProjectContent(
  cwd: unknown,
  query: unknown,
  options: { limit?: number } = {},
): Promise<ProjectSearchHit[]> {
  const root = resolveWorkspaceRoot(cwd)
  if (typeof query !== "string" || query.includes("\0")) return []
  if (query.trim().length === 0) return []
  const limit = clampLimit(options.limit, PROJECT_SEARCH_LIMIT, 2000)
  const viaGit = await gitGrep(root, query, limit)
  if (viaGit !== null) return viaGit
  return scanFiles(root, query, limit)
}
