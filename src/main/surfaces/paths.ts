import { realpathSync, statSync } from "node:fs"
import { isAbsolute, join, resolve, sep } from "node:path"

export type ContainedPath = {
  root: string
  absolutePath: string
  relativePath: string
}

export class SurfacePathError extends Error {}

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/

function reject(reason: string): never {
  throw new SurfacePathError(reason)
}

function toPosixPath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/")
}

function withTrailingSeparator(dir: string): string {
  return dir.endsWith(sep) ? dir : dir + sep
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(withTrailingSeparator(root))
}

function realpathOrReject(target: string, reason: string): string {
  try {
    return realpathSync(target)
  } catch {
    return reject(reason)
  }
}

export function resolveWorkspaceRoot(cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
    reject("Invalid workspace path")
  }
  const root = realpathOrReject(cwd, `Workspace not found: ${cwd}`)
  if (!statSync(root).isDirectory()) {
    reject(`Workspace is not a directory: ${cwd}`)
  }
  return root
}

export function resolveContainedPath(
  cwd: unknown,
  relPath: unknown,
): ContainedPath {
  const root = resolveWorkspaceRoot(cwd)
  if (typeof relPath !== "string" || relPath.includes("\0")) {
    reject("Invalid path")
  }
  if (isAbsolute(relPath) || WINDOWS_DRIVE_PREFIX.test(relPath)) {
    reject("Path must be relative to the workspace")
  }

  const lexical = resolve(join(root, relPath))
  if (!isInside(root, lexical)) {
    reject("Path escapes the workspace")
  }

  const absolutePath = realpathOrReject(lexical, `Not found: ${relPath}`)
  if (!isInside(root, absolutePath)) {
    reject("Path escapes the workspace")
  }

  return {
    root,
    absolutePath,
    relativePath: toPosixPath(absolutePath.slice(root.length).replace(/^[/\\]/, "")),
  }
}

export function isContainedIn(root: string, absolutePath: string): boolean {
  return isInside(root, absolutePath)
}
