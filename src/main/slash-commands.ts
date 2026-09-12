import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { ProviderId } from "@shared/types"
import type { SlashCommand } from "@shared/slash-commands"

/**
 * Discover the `/name` commands a CLI would accept in this project, so the
 * composer can offer them the way the terminal does.
 *
 *   claude   .claude/skills/<name>/SKILL.md, .claude/commands/<name>.md
 *            — in the project and under ~/.claude
 *   codex    .codex/prompts/<name>.md in the project and under ~/.codex
 *
 * Built-ins (/clear, /compact, /model…) are deliberately left out: they
 * drive the TUI and mean nothing to a `-p` / `exec` turn.
 */

export type ScanOptions = {
  /** Where the user-level `.claude` / `.codex` live; defaults to the home dir. */
  home?: string
}

const CACHE_TTL_MS = 10_000
const DESCRIPTION_MAX = 140

/** A command name the CLI would accept on the line: no spaces or slashes. */
const NAME_RE = /^[\w.-]+$/

type Root = { dir: string; layout: "skills" | "files"; source: SlashCommand["source"] }

function roots(provider: ProviderId, cwd: string, home: string): Root[] {
  switch (provider) {
    case "claude":
      return [
        { dir: join(cwd, ".claude", "skills"), layout: "skills", source: "project" },
        { dir: join(cwd, ".claude", "commands"), layout: "files", source: "project" },
        { dir: join(home, ".claude", "skills"), layout: "skills", source: "user" },
        { dir: join(home, ".claude", "commands"), layout: "files", source: "user" },
      ]
    case "codex":
      return [
        { dir: join(cwd, ".codex", "prompts"), layout: "files", source: "project" },
        { dir: join(home, ".codex", "prompts"), layout: "files", source: "user" },
      ]
    default:
      return []
  }
}

/**
 * Pull `description:` (and `name:`) out of a YAML frontmatter block without a
 * YAML parser — the values these files carry are one-line scalars.
 */
export function parseFrontmatter(text: string): {
  fields: Record<string, string>
  body: string
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    fields[kv[1].toLowerCase()] = value
  }
  return { fields, body: text.slice(m[0].length) }
}

/** The frontmatter description, else the first line of prose, trimmed to fit. */
export function describeCommandFile(text: string): {
  name?: string
  description: string
} {
  const { fields, body } = parseFrontmatter(text)
  let description = fields.description ?? ""
  if (!description) {
    const line = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("<!--"))
    description = line ? line.replace(/^#+\s*/, "") : ""
  }
  description = description.replace(/\s+/g, " ").trim()
  if (description.length > DESCRIPTION_MAX) {
    description = `${description.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
  }
  const name = fields.name?.trim()
  return NAME_RE.test(name ?? "") ? { name, description } : { description }
}

async function scanRoot(root: Root, provider: ProviderId): Promise<SlashCommand[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(root.dir, { withFileTypes: true })
  } catch {
    // Missing directory is the normal case for most projects.
    return []
  }
  const out: SlashCommand[] = []
  for (const entry of entries) {
    let file: string
    let fallbackName: string
    if (root.layout === "skills") {
      if (!entry.isDirectory()) continue
      file = join(root.dir, entry.name, "SKILL.md")
      fallbackName = entry.name
    } else {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      file = join(root.dir, entry.name)
      fallbackName = basename(entry.name, ".md")
    }
    if (!NAME_RE.test(fallbackName)) continue
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch {
      // A skill directory without SKILL.md is not a skill.
      continue
    }
    const { name, description } = describeCommandFile(text)
    out.push({
      name: name ?? fallbackName,
      description,
      source: root.source,
      provider,
    })
  }
  return out
}

/** Uncached scan. Same name in two places: the earlier root wins. */
export async function scanSlashCommands(
  provider: ProviderId,
  cwd: string,
  opts: ScanOptions = {},
): Promise<SlashCommand[]> {
  const home = opts.home ?? homedir()
  const seen = new Map<string, SlashCommand>()
  for (const root of roots(provider, cwd, home)) {
    for (const cmd of await scanRoot(root, provider)) {
      if (!seen.has(cmd.name)) seen.set(cmd.name, cmd)
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

type CacheEntry = { at: number; result: Promise<SlashCommand[]> }
const cache = new Map<string, CacheEntry>()

function cacheKey(provider: ProviderId, cwd: string): string {
  return `${provider}\0${cwd}`
}

/**
 * The composer asks each time a draft starts with `/`, in every window; the
 * disk answer is stable for seconds at a time, so serve it from a short cache.
 */
export function listSlashCommands(
  provider: ProviderId,
  cwd: string,
  opts: ScanOptions & { now?: () => number } = {},
): Promise<SlashCommand[]> {
  const now = opts.now ?? Date.now
  const key = cacheKey(provider, cwd)
  const hit = cache.get(key)
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.result
  const result = scanSlashCommands(provider, cwd, opts).catch((e: unknown) => {
    cache.delete(key)
    throw e
  })
  cache.set(key, { at: now(), result })
  return result
}

/** Forget cached scans — one (provider, cwd) or, with no arguments, all. */
export function invalidateSlashCommands(provider?: ProviderId, cwd?: string): void {
  if (provider !== undefined && cwd !== undefined) cache.delete(cacheKey(provider, cwd))
  else cache.clear()
}
