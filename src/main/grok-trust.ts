import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, sep } from "node:path"
import { writeFileAtomic } from "./atomic-write"
import { lockPathFor } from "./bridge-lock"
import { tomlKey } from "./toml"

const FOLDER_TABLE_PREFIX = "[folders."
const TRUSTED_ASSIGNMENT = /^trusted\s*=\s*(true|false)\s*(?:#.*)?$/
const DECIDED_AT_ASSIGNMENT = /^decided_at\s*=\s*-?\d+\s*(?:#.*)?$/

const STRING_ESCAPES = new Map([
  ["b", "\b"],
  ["t", "\t"],
  ["n", "\n"],
  ["f", "\f"],
  ["r", "\r"],
  ['"', '"'],
  ["\\", "\\"],
])

const TRUST_LOCK_WAIT_MS = 1_500
const TRUST_LOCK_RETRY_MS = 25
const TRUST_LOCK_STALE_MS = 5_000

export function defaultGrokTrustPath(): string {
  return join(homedir(), ".grok", "trusted_folders.toml")
}

export function parseTrustedFolders(text: string): Map<string, boolean> {
  const decisions = new Map<string, boolean>()
  let folder: string | null = null

  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    if (line.startsWith("[")) {
      folder = readFolderTableKey(line)
      continue
    }
    if (folder === null) continue
    const trusted = readTrustedAssignment(line)
    if (trusted !== null) decisions.set(folder, trusted)
  }

  return decisions
}

export function isFolderTrusted(text: string, folder: string): boolean {
  const target = resolveRealPath(folder)
  for (const [entry, trusted] of parseTrustedFolders(text)) {
    if (!trusted) continue
    const root = resolveRealPath(entry)
    if (target === root) return true
    if (target.startsWith(root === sep ? sep : root + sep)) return true
  }
  return false
}

export function upsertTrustedFolder(
  text: string,
  folder: string,
  decidedAt: number,
): string {
  const target = normalisePath(folder)
  const lines: string[] = []
  let headerIndex = -1
  let inTarget = false
  let sawTrusted = false
  let sawDecidedAt = false

  for (const raw of text.split("\n")) {
    const line = raw.trim()

    if (line.startsWith("[")) {
      const key = readFolderTableKey(line)
      inTarget = key !== null && normalisePath(key) === target
      if (inTarget && headerIndex === -1) headerIndex = lines.length
      lines.push(raw)
      continue
    }

    if (inTarget && readTrustedAssignment(line) !== null) {
      lines.push("trusted = true")
      sawTrusted = true
      continue
    }
    if (inTarget && DECIDED_AT_ASSIGNMENT.test(line)) {
      lines.push(`decided_at = ${decidedAt}`)
      sawDecidedAt = true
      continue
    }

    lines.push(raw)
  }

  if (headerIndex === -1) return appendFolderTable(text, target, decidedAt)

  const missing: string[] = []
  if (!sawTrusted) missing.push("trusted = true")
  if (!sawDecidedAt) missing.push(`decided_at = ${decidedAt}`)
  lines.splice(headerIndex + 1, 0, ...missing)
  return lines.join("\n")
}

export async function readGrokTrust(
  path: string = defaultGrokTrustPath(),
): Promise<{ path: string; text: string }> {
  try {
    return { path, text: await readFile(path, "utf8") }
  } catch {
    return { path, text: "" }
  }
}

export async function grokFolderTrusted(
  folder: string,
  path: string = defaultGrokTrustPath(),
): Promise<boolean> {
  const store = await readGrokTrust(path)
  return isFolderTrusted(store.text, folder)
}

/**
 * Grant Grok's folder trust for `folder`. `now` is epoch milliseconds; the
 * store records `decided_at` in seconds. Resolves to the trust state read back
 * out of the bytes we wrote, so a refused or lost write reports `false` rather
 * than a success the next Grok turn would contradict.
 */
export async function trustGrokFolder(
  folder: string,
  path: string = defaultGrokTrustPath(),
  now: number = Date.now(),
): Promise<boolean> {
  const target = resolveRealPath(folder)
  assertRecordableRoot(target)
  await waitForGrokTrustWriter(lockPathFor(path))
  const store = await readGrokTrust(path)
  const next = upsertTrustedFolder(store.text, target, Math.floor(now / 1000))
  await writeFileAtomic(path, next)
  return isFolderTrusted(next, target)
}

function readFolderTableKey(line: string): string | null {
  if (!line.startsWith(FOLDER_TABLE_PREFIX)) return null
  const rest = line.slice(FOLDER_TABLE_PREFIX.length)
  const key = readQuotedString(rest)
  if (!key) return null
  const tail = rest.slice(key.length).trimStart()
  if (!tail.startsWith("]")) return null
  const trailing = tail.slice(1).trim()
  if (trailing !== "" && !trailing.startsWith("#")) return null
  return key.value
}

function readQuotedString(
  text: string,
): { value: string; length: number } | null {
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1)
    return end === -1 ? null : { value: text.slice(1, end), length: end + 1 }
  }
  if (!text.startsWith('"')) return null

  let value = ""
  for (let i = 1; i < text.length; i++) {
    const char = text[i]
    if (char === '"') return { value, length: i + 1 }
    if (char !== "\\") {
      value += char
      continue
    }
    const escape = readEscape(text, i + 1)
    if (!escape) return null
    value += escape.value
    i += escape.length
  }
  return null
}

function readEscape(
  text: string,
  at: number,
): { value: string; length: number } | null {
  const marker = text[at]
  if (marker === undefined) return null

  const simple = STRING_ESCAPES.get(marker)
  if (simple !== undefined) return { value: simple, length: 1 }

  const width = marker === "u" ? 4 : marker === "U" ? 8 : 0
  if (width === 0) return null
  const digits = text.slice(at + 1, at + 1 + width)
  if (digits.length !== width || !/^[0-9a-fA-F]+$/.test(digits)) return null
  return {
    value: String.fromCodePoint(parseInt(digits, 16)),
    length: width + 1,
  }
}

function readTrustedAssignment(line: string): boolean | null {
  const match = TRUSTED_ASSIGNMENT.exec(line)
  return match ? match[1] === "true" : null
}

function appendFolderTable(
  text: string,
  folder: string,
  decidedAt: number,
): string {
  const table = [
    `[folders.${tomlKey(folder)}]`,
    "trusted = true",
    `decided_at = ${decidedAt}`,
    "",
  ].join("\n")
  if (text.trim() === "") return table
  const gap = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"
  return text + gap + table
}

function normalisePath(folder: string): string {
  let out = folder.trim()
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1)
  return out
}

function resolveRealPath(folder: string): string {
  try {
    return normalisePath(realpathSync(folder))
  } catch {
    return normalisePath(folder)
  }
}

function assertRecordableRoot(folder: string): void {
  if (!isAbsolute(folder)) {
    throw new Error(`Not an absolute folder path: ${folder}`)
  }
  if (folder === sep || folder === normalisePath(homedir())) {
    throw new Error(
      "Grok refuses folder trust for your home directory and the filesystem root — trust a project folder instead",
    )
  }
}

/**
 * Grok's trust store has a sibling `.lock` its own writer takes, but that file
 * is permanent and zero-byte when free, so `withBridgeLock`'s exclusive-create
 * can never acquire it. Wait for a live holder to clear, then write regardless:
 * `writeFileAtomic` publishes by rename, so the worst a lost race costs is one
 * trust decision, never a half-written store.
 */
async function waitForGrokTrustWriter(lockPath: string): Promise<void> {
  const deadline = Date.now() + TRUST_LOCK_WAIT_MS
  while (Date.now() < deadline && (await trustLockHeld(lockPath))) {
    await new Promise((resolve) => setTimeout(resolve, TRUST_LOCK_RETRY_MS))
  }
}

async function trustLockHeld(lockPath: string): Promise<boolean> {
  let holder = ""
  try {
    holder = (await readFile(lockPath, "utf8")).trim()
  } catch {
    return false
  }
  const [pid, heldSince] = holder.split(":")
  const since = Number(heldSince)
  if (!Number.isFinite(since)) return false
  if (Date.now() - since * 1000 > TRUST_LOCK_STALE_MS) return false
  return processAlive(Number(pid))
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}
