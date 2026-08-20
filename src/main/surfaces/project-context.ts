import { readFile, readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  CONTEXT_DIR_REL,
  CONTEXT_DOCS,
  CONTEXT_DOC_LIMIT_CHARS,
  CONTEXT_SETTINGS_REL,
  DEFAULT_CONTEXT_SHARE,
  SHARE_WHEN_UNRECORDED,
  buildContextBrief,
  contextDocSpec,
  parseContextSettings,
  type ContextDoc,
  type ContextDocSpec,
  type ContextSettings,
  type ProjectContext,
} from "@shared/project-context"
import {
  detectProject,
  seedContextDocs,
  type ProjectFacts,
} from "@shared/project-detect"
import { writeFileAtomic } from "../atomic-write"
import { isEnoent } from "../fs-util"
import { isBoardTodoOpen } from "@shared/surfaces"
import { readBoard } from "./board"
import {
  SurfacePathError,
  isContainedIn,
  resolveContainedPath,
  resolveWorkspaceRoot,
} from "./paths"

/** Enough of a manifest to detect a stack; a huge one is a generated file. */
const DETECT_READ_LIMIT = 256 * 1024

/** Build output and dependency trees say nothing about how a project is laid out. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
])

type DiskDoc = { text: string; updatedAt: number }

/**
 * Absolute path of one context document. The id always comes from the fixed
 * `CONTEXT_DOCS` table rather than from the caller, so no path fragment can
 * reach here; the containment check catches the table itself being edited into
 * something with a traversal in it.
 */
function docPath(root: string, spec: ContextDocSpec): string {
  const file = join(root, CONTEXT_DIR_REL, spec.file)
  if (!isContainedIn(root, file)) {
    throw new SurfacePathError("Path escapes the workspace")
  }
  return file
}

function settingsPath(root: string): string {
  return join(root, CONTEXT_SETTINGS_REL)
}

async function readDoc(root: string, spec: ContextDocSpec): Promise<DiskDoc | null> {
  const file = docPath(root, spec)
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)])
    return { text, updatedAt: info.mtimeMs }
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

function readDocs(root: string): Promise<(DiskDoc | null)[]> {
  return Promise.all(CONTEXT_DOCS.map((spec) => readDoc(root, spec)))
}

async function readSettings(root: string): Promise<ContextSettings> {
  let text: string
  try {
    text = await readFile(settingsPath(root), "utf8")
  } catch (e) {
    if (isEnoent(e)) return { share: SHARE_WHEN_UNRECORDED, updatedAt: 0 }
    throw e
  }
  try {
    return parseContextSettings(JSON.parse(text))
  } catch {
    return { share: SHARE_WHEN_UNRECORDED, updatedAt: 0 }
  }
}

/** Read a file for detection only. Missing, unreadable or huge reads as absent. */
async function readForDetect(root: string, relPath: string): Promise<string | null> {
  try {
    const target = resolveContainedPath(root, relPath)
    const info = await stat(target.absolutePath)
    if (!info.isFile() || info.size > DETECT_READ_LIMIT) return null
    return await readFile(target.absolutePath, "utf8")
  } catch {
    return null
  }
}

/**
 * What the repository already says about itself. `.git/config` is only readable
 * in a normal checkout — inside a linked worktree `.git` is a file pointing out
 * of the workspace, so those sessions simply detect no remote.
 */
async function detectFacts(root: string): Promise<ProjectFacts> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return detectProject({
    folderName: basename(root),
    packageJson: await readForDetect(root, "package.json"),
    gitConfig: await readForDetect(root, ".git/config"),
    entries: entries.map((entry) => entry.name),
    directories: entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !SKIP_DIRECTORIES.has(entry.name),
      )
      .map((entry) => entry.name),
  })
}

function toDocs(
  found: readonly (DiskDoc | null)[],
  draft: Record<string, string> | null,
): ContextDoc[] {
  return CONTEXT_DOCS.map((spec, i) => ({
    id: spec.id,
    file: spec.file,
    title: spec.title,
    text: found[i]?.text ?? draft?.[spec.id] ?? "",
    updatedAt: found[i]?.updatedAt ?? 0,
  }))
}

/**
 * Read a workspace's context.
 *
 * A folder that was never created is not an error: the documents come back as a
 * detected draft with `seeded: false`, so the surface can show the owner exactly
 * what it would write before anything touches their repository. Anything else —
 * an invalid workspace, an unreadable file — throws, the same contract the board
 * uses, because a silent empty read would look like "no context" and hide it.
 */
export async function readProjectContext(cwd: unknown): Promise<ProjectContext> {
  const root = resolveWorkspaceRoot(cwd)
  const found = await readDocs(root)
  const seeded = found.some((doc) => doc !== null)
  const draft = seeded ? null : seedContextDocs(await detectFacts(root))
  const docs = toDocs(found, draft)
  const settings = await readSettings(root)
  return {
    docs,
    seeded,
    share: settings.share,
    updatedAt: Math.max(settings.updatedAt, ...docs.map((doc) => doc.updatedAt)),
  }
}

function normalizeDoc(text: string): string {
  const body = text.replace(/\r\n?/g, "\n").trimEnd()
  return body === "" ? "" : `${body}\n`
}

/** Record the share switch on first write so the file is there to be edited. */
async function ensureSettings(root: string): Promise<void> {
  const file = settingsPath(root)
  try {
    await stat(file)
    return
  } catch (e) {
    if (!isEnoent(e)) throw e
  }
  await writeSettings(root, DEFAULT_CONTEXT_SHARE)
}

function writeSettings(root: string, share: boolean): Promise<void> {
  const body = JSON.stringify({ share, updatedAt: Date.now() }, null, 2)
  return writeFileAtomic(settingsPath(root), `${body}\n`)
}

export async function writeContextDoc(
  cwd: unknown,
  id: unknown,
  text: unknown,
): Promise<ProjectContext> {
  const root = resolveWorkspaceRoot(cwd)
  const spec = contextDocSpec(id)
  if (!spec) throw new Error(`Unknown context document: ${String(id)}`)
  if (typeof text !== "string") throw new Error("Invalid document text")
  if (text.length > CONTEXT_DOC_LIMIT_CHARS) {
    throw new Error(
      `${spec.file} is too long (${text.length} of ${CONTEXT_DOC_LIMIT_CHARS} characters)`,
    )
  }
  await writeFileAtomic(docPath(root, spec), normalizeDoc(text))
  await ensureSettings(root)
  return readProjectContext(cwd)
}

/**
 * Create the folder, or re-detect one document.
 *
 * With no id this is "create `.chathub/context/`": every missing document is
 * written from the detected draft and every existing one is left alone, so it is
 * safe to press twice. With an id it is the deliberate re-detect behind the
 * Stack panel's button, and that one document IS overwritten.
 */
export async function seedProjectContext(
  cwd: unknown,
  id?: unknown,
): Promise<ProjectContext> {
  const root = resolveWorkspaceRoot(cwd)
  const only = id === undefined || id === null ? null : contextDocSpec(id)
  if (id !== undefined && id !== null && !only) {
    throw new Error(`Unknown context document: ${String(id)}`)
  }
  const [facts, found] = await Promise.all([detectFacts(root), readDocs(root)])
  const seeds = seedContextDocs(facts)
  for (const [i, spec] of CONTEXT_DOCS.entries()) {
    if (only) {
      if (spec.id !== only.id) continue
    } else if (found[i] !== null) {
      continue
    }
    await writeFileAtomic(docPath(root, spec), seeds[spec.id])
  }
  await ensureSettings(root)
  return readProjectContext(cwd)
}

export async function setContextShare(
  cwd: unknown,
  share: unknown,
): Promise<ProjectContext> {
  if (typeof share !== "boolean") throw new Error("Invalid share flag")
  const root = resolveWorkspaceRoot(cwd)
  await writeSettings(root, share)
  return readProjectContext(cwd)
}

/** Open todos, newest last, as the "right now" half of the brief. */
async function openTodoTexts(cwd: unknown): Promise<string[]> {
  const board = await readBoard(cwd).catch(() => null)
  return (board?.todos ?? [])
    .filter((todo) => isBoardTodoOpen(todo))
    .map((todo) => todo.text)
}

/**
 * The brief appended to one turn's system prompt, or "" when there is nothing
 * to send. Never throws and never seeds: a turn must not fail, slow down or
 * write to the repository because a context file is missing or unreadable, and
 * an un-created draft is nobody's context until the owner says so.
 */
export async function projectContextBrief(cwd: unknown): Promise<string> {
  try {
    const root = resolveWorkspaceRoot(cwd)
    const settings = await readSettings(root)
    if (!settings.share) return ""
    const found = await readDocs(root)
    if (found.every((doc) => doc === null)) return ""
    return buildContextBrief(toDocs(found, null), await openTodoTexts(cwd))
  } catch {
    return ""
  }
}
