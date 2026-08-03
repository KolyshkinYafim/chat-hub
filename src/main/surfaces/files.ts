import { open, readdir, realpath, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Dirent } from "node:fs"
import {
  BINARY_SNIFF_BYTES,
  FILE_READ_LIMIT_BYTES,
  HIDDEN_FROM_LISTING,
  type DirEntry,
  type DirListing,
  type FileContents,
} from "@shared/surfaces"
import { isContainedIn, resolveContainedPath } from "./paths"

const SKIPPED_NAMES = new Set(HIDDEN_FROM_LISTING)

function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return 0
}

function childPath(parentRelPath: string, name: string): string {
  return parentRelPath ? `${parentRelPath}/${name}` : name
}

async function describeEntry(
  root: string,
  dirAbsolutePath: string,
  parentRelPath: string,
  dirent: Dirent,
): Promise<DirEntry | null> {
  const absolutePath = join(dirAbsolutePath, dirent.name)
  const path = childPath(parentRelPath, dirent.name)

  if (dirent.isSymbolicLink()) {
    try {
      const target = await realpath(absolutePath)
      if (!isContainedIn(root, target)) return null
      const targetStats = await stat(target)
      if (targetStats.isDirectory()) {
        return { name: dirent.name, path, kind: "dir" }
      }
      if (!targetStats.isFile()) return null
      return { name: dirent.name, path, kind: "file", size: targetStats.size }
    } catch {
      return null
    }
  }

  if (dirent.isDirectory()) {
    return { name: dirent.name, path, kind: "dir" }
  }
  if (!dirent.isFile()) return null

  try {
    const stats = await stat(absolutePath)
    return { name: dirent.name, path, kind: "file", size: stats.size }
  } catch {
    return { name: dirent.name, path, kind: "file" }
  }
}

export async function listDir(
  cwd: unknown,
  relPath: unknown,
): Promise<DirListing> {
  const contained = resolveContainedPath(cwd, relPath ?? "")
  const stats = await stat(contained.absolutePath)
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${contained.relativePath}`)
  }

  const dirents = await readdir(contained.absolutePath, { withFileTypes: true })
  const described = await Promise.all(
    dirents
      .filter((dirent) => !SKIPPED_NAMES.has(dirent.name))
      .map((dirent) =>
        describeEntry(
          contained.root,
          contained.absolutePath,
          contained.relativePath,
          dirent,
        ),
      ),
  )

  const entries = described.filter((entry): entry is DirEntry => entry !== null)
  entries.sort(compareEntries)
  return { path: contained.relativePath, entries }
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

export async function readFileText(
  cwd: unknown,
  relPath: unknown,
): Promise<FileContents> {
  const contained = resolveContainedPath(cwd, relPath)
  const stats = await stat(contained.absolutePath)
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${contained.relativePath}`)
  }

  const wanted = Math.min(stats.size, FILE_READ_LIMIT_BYTES)
  const handle = await open(contained.absolutePath, "r")
  let bytes: Buffer
  try {
    const buffer = Buffer.alloc(wanted)
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0)
    bytes = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }

  if (looksBinary(bytes)) {
    return {
      path: contained.relativePath,
      text: "",
      truncated: false,
      binary: true,
    }
  }

  return {
    path: contained.relativePath,
    text: bytes.toString("utf8"),
    truncated: stats.size > FILE_READ_LIMIT_BYTES,
    binary: false,
  }
}
