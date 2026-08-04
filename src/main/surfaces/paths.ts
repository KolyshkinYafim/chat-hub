import { realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"

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

function relativeToRoot(root: string, absolutePath: string): string {
  return toPosixPath(absolutePath.slice(root.length).replace(/^[/\\]/, ""))
}

/** Lexically normalized target, before any symlink is followed. */
function lexicalTarget(root: string, relPath: unknown): string {
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
  return lexical
}

export function resolveContainedPath(
  cwd: unknown,
  relPath: unknown,
): ContainedPath {
  const root = resolveWorkspaceRoot(cwd)
  const lexical = lexicalTarget(root, relPath)

  const absolutePath = realpathOrReject(lexical, `Not found: ${String(relPath)}`)
  if (!isInside(root, absolutePath)) {
    reject("Path escapes the workspace")
  }

  return {
    root,
    absolutePath,
    relativePath: relativeToRoot(root, absolutePath),
  }
}

/**
 * Where something that does not exist yet may be created. The target has no
 * realpath of its own, so containment is decided on its parent directory — the
 * same reasoning `resolveContainedPath` applies to an existing target — and only
 * the basename is joined onto the resolved parent. A parent that is missing, is
 * not a directory, or is reached through a symlink out of the workspace is
 * refused, and so is the workspace root itself.
 */
export function resolveCreatablePath(
  cwd: unknown,
  relPath: unknown,
): ContainedPath {
  const root = resolveWorkspaceRoot(cwd)
  const lexical = lexicalTarget(root, relPath)
  if (lexical === root) {
    reject("Path must name something to create inside the workspace")
  }

  const parentLexical = dirname(lexical)
  const parentRelative = relativeToRoot(root, parentLexical) || "."
  const parent = realpathOrReject(
    parentLexical,
    `Parent folder not found: ${parentRelative}`,
  )
  if (!isInside(root, parent)) {
    reject("Path escapes the workspace")
  }
  if (!statSync(parent).isDirectory()) {
    reject(`Not a directory: ${parentRelative}`)
  }

  const absolutePath = join(parent, basename(lexical))
  return {
    root,
    absolutePath,
    relativePath: relativeToRoot(root, absolutePath),
  }
}

export function isContainedIn(root: string, absolutePath: string): boolean {
  return isInside(root, absolutePath)
}
