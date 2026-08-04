import { open, readdir, realpath, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Dirent, Stats } from "node:fs"
import {
  BINARY_SNIFF_BYTES,
  FILE_READ_LIMIT_BYTES,
  FILE_WRITE_LIMIT_BYTES,
  HIDDEN_FROM_LISTING,
  INLINE_IMAGE_LIMIT_BYTES,
  STALE_WRITE_MESSAGE,
  type DirEntry,
  type DirListing,
  type FileContents,
  type FileSaved,
  type FileStamp,
  type OpenedFile,
} from "@shared/surfaces"
import { carriesEditableText, detectFileType } from "@shared/file-kind"
import { isContainedIn, resolveContainedPath } from "./paths"

const SKIPPED_NAMES = new Set(HIDDEN_FROM_LISTING)

export type MediaGrant = {
  root: string
  absolutePath: string
  mime: string
}

export type MediaUrlMinter = (grant: MediaGrant) => string

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

function stampOf(stats: Stats): FileStamp {
  return { mtimeMs: Math.round(stats.mtimeMs), size: stats.size }
}

async function readHead(absolutePath: string, wanted: number): Promise<Buffer> {
  if (wanted <= 0) return Buffer.alloc(0)
  const handle = await open(absolutePath, "r")
  try {
    const buffer = Buffer.alloc(wanted)
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function statFile(absolutePath: string, relativePath: string): Promise<Stats> {
  const stats = await stat(absolutePath)
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${relativePath}`)
  }
  return stats
}

export async function readFileText(
  cwd: unknown,
  relPath: unknown,
): Promise<FileContents> {
  const contained = resolveContainedPath(cwd, relPath)
  const stats = await statFile(contained.absolutePath, contained.relativePath)

  const bytes = await readHead(
    contained.absolutePath,
    Math.min(stats.size, FILE_READ_LIMIT_BYTES),
  )

  if (looksBinary(bytes)) {
    return {
      path: contained.relativePath,
      text: "",
      truncated: false,
      binary: true,
      stamp: stampOf(stats),
    }
  }

  return {
    path: contained.relativePath,
    text: bytes.toString("utf8"),
    truncated: stats.size > FILE_READ_LIMIT_BYTES,
    binary: false,
    stamp: stampOf(stats),
  }
}

function describeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function openFile(
  cwd: unknown,
  relPath: unknown,
  mintMediaUrl: MediaUrlMinter,
): Promise<OpenedFile> {
  const contained = resolveContainedPath(cwd, relPath)
  const stats = await statFile(contained.absolutePath, contained.relativePath)

  const head = await readHead(
    contained.absolutePath,
    Math.min(stats.size, BINARY_SNIFF_BYTES),
  )
  const type = detectFileType(contained.relativePath, head)

  const opened: OpenedFile = {
    path: contained.relativePath,
    absolutePath: contained.absolutePath,
    kind: type.kind,
    mime: type.mime,
    size: stats.size,
    stamp: stampOf(stats),
    text: null,
    truncated: false,
    dataUrl: null,
    streamUrl: null,
    unavailable: null,
  }

  if (carriesEditableText(type)) {
    const bytes = await readHead(
      contained.absolutePath,
      Math.min(stats.size, FILE_READ_LIMIT_BYTES),
    )
    opened.text = bytes.toString("utf8")
    opened.truncated = stats.size > FILE_READ_LIMIT_BYTES
  }

  if (type.kind === "image") {
    if (stats.size > INLINE_IMAGE_LIMIT_BYTES) {
      opened.unavailable = `Image is ${describeBytes(stats.size)} — too large to show inline.`
    } else {
      const bytes = await readHead(contained.absolutePath, stats.size)
      opened.dataUrl = `data:${type.mime};base64,${bytes.toString("base64")}`
    }
  }

  if (type.kind === "video" || type.kind === "audio") {
    opened.streamUrl = mintMediaUrl({
      root: contained.root,
      absolutePath: contained.absolutePath,
      mime: type.mime,
    })
  }

  if (type.kind === "pdf") {
    opened.unavailable =
      "Chat Hub runs without the Chromium PDF plugin, so it cannot render this inline."
  }

  return opened
}

function toStamp(value: unknown): FileStamp | null {
  if (typeof value !== "object" || value === null) return null
  const candidate = value as Partial<FileStamp>
  if (
    typeof candidate.mtimeMs !== "number" ||
    !Number.isFinite(candidate.mtimeMs) ||
    typeof candidate.size !== "number" ||
    !Number.isFinite(candidate.size)
  ) {
    return null
  }
  return { mtimeMs: candidate.mtimeMs, size: candidate.size }
}

export async function saveFileText(
  cwd: unknown,
  relPath: unknown,
  text: unknown,
  readStamp: unknown,
): Promise<FileSaved> {
  if (typeof text !== "string") {
    throw new Error("Refusing to save: the payload is not text")
  }
  const byteLength = Buffer.byteLength(text, "utf8")
  if (byteLength > FILE_WRITE_LIMIT_BYTES) {
    throw new Error(
      `Refusing to save ${describeBytes(byteLength)} — over the ${describeBytes(FILE_WRITE_LIMIT_BYTES)} save cap`,
    )
  }
  const expected = toStamp(readStamp)
  if (!expected) {
    throw new Error("Refusing to save: no read stamp to compare against")
  }

  const contained = resolveContainedPath(cwd, relPath)
  const stats = await statFile(contained.absolutePath, contained.relativePath)
  const current = stampOf(stats)
  if (
    current.mtimeMs !== expected.mtimeMs ||
    current.size !== expected.size
  ) {
    throw new Error(`${contained.relativePath} ${STALE_WRITE_MESSAGE}`)
  }

  await writeFile(contained.absolutePath, text, "utf8")
  const written = await stat(contained.absolutePath)
  return { path: contained.relativePath, stamp: stampOf(written) }
}
