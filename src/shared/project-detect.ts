/**
 * First-run detection for `.chathub/context/`: turn what a repository already
 * says about itself into a draft the owner only has to correct. Pure — the main
 * process reads the files and hands the text in, so every rule here is unit
 * testable without a workspace.
 */

import type { ContextDocId } from "./project-context"

export type DetectInput = {
  /** Basename of the workspace root; the fallback project name. */
  folderName: string
  packageJson: string | null
  /** `.git/config` text; absent inside a linked worktree, where `.git` is a file. */
  gitConfig: string | null
  /** Top-level entry names, files and directories alike. */
  entries: readonly string[]
  /** Top-level directory names, already filtered of noise by the caller. */
  directories: readonly string[]
}

export type DetectedScript = { name: string; command: string }

export type ProjectFacts = {
  name: string
  description: string
  /** Normalized https URL of the origin remote, or null. */
  remote: string | null
  languages: string[]
  packageManager: string | null
  frameworks: string[]
  scripts: DetectedScript[]
  directories: string[]
}

const LOCKFILES: readonly [string, string][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
]

/** Marker file → language, for the ecosystems that do not ship a package.json. */
const LANGUAGE_MARKERS: readonly [string, string][] = [
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["setup.py", "Python"],
  ["go.mod", "Go"],
  ["Cargo.toml", "Rust"],
  ["Gemfile", "Ruby"],
  ["composer.json", "PHP"],
  ["pom.xml", "Java"],
  ["build.gradle", "Java"],
  ["build.gradle.kts", "Kotlin"],
  ["Package.swift", "Swift"],
]

/** Dependency name → the label a human would use for it. */
const FRAMEWORKS: readonly [string, string][] = [
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["electron", "Electron"],
  ["react-native", "React Native"],
  ["expo", "Expo"],
  ["@nestjs/core", "NestJS"],
  ["fastify", "Fastify"],
  ["express", "Express"],
  ["@prisma/client", "Prisma"],
  ["drizzle-orm", "Drizzle"],
  ["mongoose", "Mongoose"],
  ["tailwindcss", "Tailwind"],
  ["vite", "Vite"],
  ["webpack", "webpack"],
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["playwright", "Playwright"],
  ["@playwright/test", "Playwright"],
  ["cypress", "Cypress"],
]

/** Scripts worth putting in front of a newcomer, in the order they matter. */
const SCRIPT_ORDER: readonly string[] = [
  "dev",
  "start",
  "build",
  "test",
  "typecheck",
  "lint",
  "e2e",
]

const MAX_DIRECTORIES = 8

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function parseJson(text: string | null): Record<string, unknown> {
  if (!text) return {}
  try {
    return record(JSON.parse(text))
  } catch {
    return {}
  }
}

/**
 * `git@host:owner/repo.git` and `ssh://git@host/owner/repo` both name the same
 * page a human would open, so both normalize to the https form. Anything that
 * is not a recognisable remote (a local path, a bare name) is dropped rather
 * than guessed at.
 */
export function normalizeRemoteUrl(raw: string): string | null {
  const url = raw.trim().replace(/\.git$/, "")
  if (url === "") return null
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url)
  if (scp) return `https://${scp[1]}/${scp[2]}`
  const ssh = /^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  if (/^https?:\/\//.test(url)) return url
  return null
}

/** Pull `origin`'s url out of a `.git/config`; other remotes are ignored. */
export function parseGitConfigRemote(config: string | null): string | null {
  if (!config) return null
  let inOrigin = false
  for (const line of config.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(trimmed)
      continue
    }
    if (!inOrigin) continue
    const match = /^url\s*=\s*(.+)$/.exec(trimmed)
    if (match) return normalizeRemoteUrl(match[1])
  }
  return null
}

function detectPackageManager(
  entries: readonly string[],
  pkg: Record<string, unknown>,
): string | null {
  for (const [file, manager] of LOCKFILES) {
    if (entries.includes(file)) return manager
  }
  const declared = str(pkg.packageManager)
  if (declared) return declared.split("@")[0]
  return entries.includes("package.json") ? "npm" : null
}

function detectLanguages(
  entries: readonly string[],
  pkg: Record<string, unknown>,
  deps: Record<string, unknown>,
): string[] {
  const out: string[] = []
  const hasPackageJson = entries.includes("package.json") || Object.keys(pkg).length > 0
  if (entries.includes("tsconfig.json") || "typescript" in deps) {
    out.push("TypeScript")
  } else if (hasPackageJson) {
    out.push("JavaScript")
  }
  for (const [marker, language] of LANGUAGE_MARKERS) {
    if (entries.includes(marker) && !out.includes(language)) out.push(language)
  }
  return out
}

function detectFrameworks(deps: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [dep, label] of FRAMEWORKS) {
    if (dep in deps && !out.includes(label)) out.push(label)
  }
  return out
}

function detectScripts(pkg: Record<string, unknown>): DetectedScript[] {
  const scripts = record(pkg.scripts)
  const out: DetectedScript[] = []
  for (const name of SCRIPT_ORDER) {
    const command = str(scripts[name])
    if (command) out.push({ name, command })
  }
  return out
}

export function detectProject(input: DetectInput): ProjectFacts {
  const pkg = parseJson(input.packageJson)
  const deps = { ...record(pkg.dependencies), ...record(pkg.devDependencies) }
  return {
    name: str(pkg.name) || input.folderName,
    description: str(pkg.description),
    remote: parseGitConfigRemote(input.gitConfig),
    languages: detectLanguages(input.entries, pkg, deps),
    packageManager: detectPackageManager(input.entries, pkg),
    frameworks: detectFrameworks(deps),
    scripts: detectScripts(pkg),
    directories: [...input.directories].sort().slice(0, MAX_DIRECTORIES),
  }
}

function runCommand(facts: ProjectFacts, script: string): string | null {
  const found = facts.scripts.find((s) => s.name === script)
  if (!found) return null
  const manager = facts.packageManager ?? "npm"
  const prefix = manager === "npm" ? "npm run" : `${manager} run`
  return `${prefix} ${script}`
}

function bullet(label: string, value: string): string | null {
  return value === "" ? null : `- ${label}: ${value}`
}

function lines(parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null).join("\n")
}

function seedOverview(facts: ProjectFacts): string {
  const summary =
    facts.description ||
    "One line about what this project is and who it is for — replace this."
  const starts = facts.directories.length
    ? `\n\n## Where to start\n\n${facts.directories
        .map((dir) => `- \`${dir}/\` — `)
        .join("\n")}`
    : ""
  return `# Overview

**${facts.name}** — ${summary}
${facts.remote ? `\nRepository: ${facts.remote}\n` : ""}
## What it does

Two or three sentences a new reader needs before touching the code: the problem
it solves, who depends on it, and what "working" looks like.${starts}
`
}

function seedStack(facts: ProjectFacts): string {
  const commands = facts.scripts
    .map((script) => {
      const run = runCommand(facts, script.name)
      return run ? `- \`${run}\` — ${script.command}` : null
    })
    .filter((line): line is string => line !== null)
  const commandBlock = commands.length
    ? `\n## Commands\n\n${commands.join("\n")}\n`
    : ""
  return `# Stack

${lines([
    bullet("Languages", facts.languages.join(", ")),
    bullet("Package manager", facts.packageManager ?? ""),
    bullet("Notable dependencies", facts.frameworks.join(", ")),
    bullet(
      "Layout",
      facts.directories.map((dir) => `\`${dir}/\``).join(", "),
    ),
  ]) || "- Add the languages and tooling this project uses."}
${commandBlock}
Detected from the repository. Re-detect from the Context panel after a
toolchain change — that button rewrites this file and nothing else.
`
}

function seedConventions(facts: ProjectFacts): string {
  const test = runCommand(facts, "test")
  const check = runCommand(facts, "typecheck") ?? runCommand(facts, "lint")
  return `# Conventions

${lines([
    "- Match the surrounding code — copy the nearest existing pattern rather than introducing a new one.",
    test ? `- Run \`${test}\` before calling a change done.` : null,
    check ? `- Run \`${check}\` too; it is part of "it builds".` : null,
    "- Keep changes scoped to what was asked. Flag anything else you notice instead of fixing it in passing.",
  ])}

Replace these with the rules that actually apply here — they are what an agent
is told to follow.
`
}

function seedFocus(): string {
  return `# Current focus

What is being worked on right now, and why. A few lines is plenty — this is the
part that goes stale fastest, so keep it short enough to be worth updating.

The task list itself lives on the board (\`.chathub/board.json\`), shown in the
Board panel; open todos are sent to the agent alongside this file.
`
}

/** Starter content for every document, ready to be written or reviewed first. */
export function seedContextDocs(
  facts: ProjectFacts,
): Record<ContextDocId, string> {
  return {
    overview: seedOverview(facts),
    stack: seedStack(facts),
    conventions: seedConventions(facts),
    focus: seedFocus(),
  }
}
