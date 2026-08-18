import { access } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  assertMcpServerDef,
  emptyMcpConfig,
  MCP_NATIVE_GITIGNORE_PATHS,
  MCP_REL_PATH,
  parseMcpConfig,
  type McpGitignoreResult,
  type McpListResult,
  type McpMaterializeResult,
  type McpProjectConfig,
  type McpServerDef,
  type McpServerStatus,
} from "@shared/mcp"
import { writeFileAtomic } from "./atomic-write"
import { isEnoent } from "./fs-util"
import { tomlKey } from "./toml"
import { resolveWorkspaceRoot } from "./surfaces/paths"
import type { SettingsStore } from "./settings"

const execFileAsync = promisify(execFile)

const CODEX_BEGIN = "# BEGIN CHATHUB-MCP"
const CODEX_END = "# END CHATHUB-MCP"

function mcpFile(cwd: unknown): string {
  const root = resolveWorkspaceRoot(cwd)
  return join(root, MCP_REL_PATH)
}

/** Read project MCP config; missing file → empty list. */
export async function readMcpConfig(cwd: unknown): Promise<McpProjectConfig> {
  const file = mcpFile(cwd)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if (isEnoent(e)) return emptyMcpConfig()
    throw e
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    // Hand-edited garbage: coerce to empty rather than wiping on next write
    // without the user knowing — caller still gets a usable empty config.
    return emptyMcpConfig()
  }
  return parseMcpConfig(raw)
}

export async function writeMcpConfig(
  cwd: unknown,
  config: McpProjectConfig,
): Promise<McpProjectConfig> {
  const root = resolveWorkspaceRoot(cwd)
  const normalized = parseMcpConfig(config)
  for (const s of normalized.servers) assertMcpServerDef(s)
  const file = join(root, MCP_REL_PATH)
  await writeFileAtomic(file, JSON.stringify(normalized, null, 2) + "\n")
  return normalized
}

export async function listMcpServers(cwd: unknown): Promise<McpServerDef[]> {
  return (await readMcpConfig(cwd)).servers
}

export async function upsertMcpServer(
  cwd: unknown,
  def: McpServerDef,
): Promise<McpProjectConfig> {
  assertMcpServerDef(def)
  const cfg = await readMcpConfig(cwd)
  const idx = cfg.servers.findIndex((s) => s.id === def.id)
  const next: McpServerDef = {
    id: def.id,
    name: def.name.trim(),
    enabled: def.enabled !== false,
    transport: def.transport,
    args: def.args ?? [],
    envKeys: def.envKeys ?? [],
  }
  if (def.transport === "stdio") {
    next.command = def.command!.trim()
  } else {
    next.url = def.url!.trim()
  }
  if (idx === -1) cfg.servers.push(next)
  else cfg.servers[idx] = next
  return writeMcpConfig(cwd, cfg)
}

export async function removeMcpServer(
  cwd: unknown,
  id: string,
): Promise<McpProjectConfig> {
  const cfg = await readMcpConfig(cwd)
  cfg.servers = cfg.servers.filter((s) => s.id !== id)
  return writeMcpConfig(cwd, cfg)
}

export async function setMcpServerEnabled(
  cwd: unknown,
  id: string,
  enabled: boolean,
): Promise<McpProjectConfig> {
  const cfg = await readMcpConfig(cwd)
  const s = cfg.servers.find((x) => x.id === id)
  if (!s) throw new Error(`MCP server not found: ${id}`)
  s.enabled = enabled
  return writeMcpConfig(cwd, cfg)
}

/** Build list payload for the renderer (no secret values). */
export async function mcpListForRenderer(
  cwd: unknown,
  settings: SettingsStore,
  withProbe = true,
): Promise<McpListResult> {
  const config = await readMcpConfig(cwd)
  const envKeysByServer: Record<string, string[]> = {}
  for (const s of config.servers) {
    envKeysByServer[s.id] = settings.getMcpEnvKeys(s.id)
  }
  const statuses = withProbe
    ? await probeMcpStatuses(config.servers)
    : config.servers.map((s) => statusStub(s))
  return { config, statuses, envKeysByServer }
}

function statusStub(s: McpServerDef): McpServerStatus {
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    transport: s.transport,
    state: s.enabled ? "unknown" : "disabled",
    detail: s.enabled ? undefined : "disabled",
    checkedAt: Date.now(),
  }
}

export async function probeMcpStatuses(
  servers: McpServerDef[],
): Promise<McpServerStatus[]> {
  return Promise.all(servers.map((s) => probeOne(s)))
}

async function probeOne(s: McpServerDef): Promise<McpServerStatus> {
  const base = {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    transport: s.transport,
    checkedAt: Date.now(),
  }
  if (!s.enabled) {
    return { ...base, state: "disabled", detail: "disabled" }
  }
  if (s.transport === "http") {
    // Network probe is flaky for many MCP URLs (auth, POST-only). Leave unknown.
    return {
      ...base,
      state: "unknown",
      detail: "http endpoint not probed",
    }
  }
  const command = s.command?.trim() ?? ""
  if (!command) {
    return { ...base, state: "error", detail: "missing command" }
  }
  const found = await resolveCommand(command)
  if (!found) {
    return { ...base, state: "error", detail: `command not found: ${command}` }
  }
  return { ...base, state: "ok", detail: found }
}

async function resolveCommand(command: string): Promise<string | null> {
  if (isAbsolute(command) || command.includes("/")) {
    try {
      await access(command, fsConstants.X_OK)
      return command
    } catch {
      try {
        await access(command, fsConstants.F_OK)
        return command
      } catch {
        return null
      }
    }
  }
  try {
    const { stdout } = await execFileAsync("which", [command], {
      timeout: 2000,
      env: process.env,
    })
    const path = stdout.trim().split("\n")[0]?.trim()
    return path || null
  } catch {
    return null
  }
}

type EnvLookup = (serverId: string) => Record<string, string>

/**
 * Write Hub MCP config into native Claude / Codex / OpenCode project files.
 * Secrets are expanded from `envFor` (decrypted settings) into those files only.
 * Never mutates `.gitignore` — the UI may offer that after seeing `unignoredNative`.
 */
export async function materializeMcpForProject(
  cwd: unknown,
  envFor: EnvLookup,
  cleanupNames: Iterable<string> = [],
): Promise<McpMaterializeResult> {
  const root = resolveWorkspaceRoot(cwd)
  const config = await readMcpConfig(cwd)
  const staleNames = new Set(cleanupNames)
  const written: string[] = []
  try {
    written.push(await materializeClaude(root, config, envFor, staleNames))
    written.push(await materializeCodex(root, config, envFor))
    const oc = await materializeOpenCode(root, config, envFor, staleNames)
    if (oc) written.push(oc)
    const kept = written.filter(Boolean)
    const unignoredNative = await listUnignoredMcpNativeFiles(root)
    return {
      ok: true,
      written: kept,
      unignoredNative:
        unignoredNative.length > 0 ? unignoredNative : undefined,
    }
  } catch (err) {
    return {
      ok: false,
      written,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Among `.mcp.json` / `opencode.json`, return those that exist on disk and are
 * not ignored by git. Empty when the folder is not a git work tree (nothing to
 * accidentally commit) or every candidate is already ignored.
 */
export async function listUnignoredMcpNativeFiles(
  root: string,
): Promise<string[]> {
  const existing: string[] = []
  for (const rel of MCP_NATIVE_GITIGNORE_PATHS) {
    try {
      await access(join(root, rel), fsConstants.F_OK)
      existing.push(rel)
    } catch {
      /* not written this time */
    }
  }
  if (existing.length === 0) return []
  if (!(await isGitWorkTree(root))) return []

  const unignored: string[] = []
  for (const rel of existing) {
    if (!(await isPathGitIgnored(root, rel))) unignored.push(rel)
  }
  return unignored
}

async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "--is-inside-work-tree"],
      { timeout: 3000, env: process.env },
    )
    return stdout.trim() === "true"
  } catch {
    return false
  }
}

/** `git check-ignore` exit 0 = ignored, 1 = not ignored. */
async function isPathGitIgnored(root: string, rel: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", root, "check-ignore", "-q", "--", rel], {
      timeout: 3000,
      env: process.env,
    })
    return true
  } catch (err) {
    const code = (err as { code?: number | string } | null)?.code
    if (code === 1) return false
    // Other failures (no git, weird path): treat as not ignored so the user
    // still sees a warning rather than silently shipping secrets.
    return false
  }
}

/**
 * Append missing paths to `<cwd>/.gitignore`. Does not run unless the UI asks.
 * Idempotent: already-present exact lines (or leading-slash variants) are skipped.
 */
export async function appendMcpPathsToGitignore(
  cwd: unknown,
  paths: string[],
): Promise<McpGitignoreResult> {
  const root = resolveWorkspaceRoot(cwd)
  const file = join(root, ".gitignore")
  const wanted = normalizeGitignoreRequests(paths)
  if (wanted.length === 0) {
    return { ok: true, path: file, added: [] }
  }

  let text = ""
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if (!isEnoent(e)) {
      return {
        ok: false,
        path: file,
        added: [],
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }

  const present = new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  )
  const added: string[] = []
  for (const p of wanted) {
    if (present.has(p) || present.has(`/${p}`)) continue
    added.push(p)
  }
  if (added.length === 0) {
    return { ok: true, path: file, added: [] }
  }

  const header = "# Chat Hub MCP — may contain secrets from Apply to CLIs"
  const needsHeader = !text.includes(header)
  const prefix =
    text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n"
  const block =
    prefix +
    (needsHeader ? `${header}\n` : "") +
    added.map((p) => `${p}\n`).join("")

  try {
    await writeFileAtomic(file, text + block)
    return { ok: true, path: file, added }
  } catch (e) {
    return {
      ok: false,
      path: file,
      added: [],
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** Only allow the known native paths — never write arbitrary gitignore lines. */
export function normalizeGitignoreRequests(paths: string[]): string[] {
  const allow = new Set<string>(MCP_NATIVE_GITIGNORE_PATHS)
  const out: string[] = []
  for (const raw of paths) {
    const p = raw.trim().replace(/^\.\//, "")
    if (allow.has(p) && !out.includes(p)) out.push(p)
  }
  return out
}

function enabledServers(config: McpProjectConfig): McpServerDef[] {
  return config.servers.filter((s) => s.enabled)
}

function hubNames(config: McpProjectConfig): Set<string> {
  return new Set(config.servers.map((s) => s.name))
}

function envForServer(
  s: McpServerDef,
  envFor: EnvLookup,
): Record<string, string> | undefined {
  const all = envFor(s.id)
  const out: Record<string, string> = {}
  for (const key of s.envKeys) {
    if (all[key] !== undefined && all[key] !== "") out[key] = all[key]
  }
  // Also include sealed keys not listed in envKeys (user set them in UI).
  for (const [k, v] of Object.entries(all)) {
    if (v) out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Claude Code: `<cwd>/.mcp.json` — merge hub keys, keep foreign servers. */
export async function materializeClaude(
  root: string,
  config: McpProjectConfig,
  envFor: EnvLookup,
  cleanupNames: Iterable<string> = [],
): Promise<string> {
  const file = join(root, ".mcp.json")
  let existing: Record<string, unknown> = {}
  try {
    const text = await readFile(file, "utf8")
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch (e) {
    if (!isEnoent(e)) throw e
  }

  const serversRaw = existing.mcpServers
  const servers: Record<string, unknown> =
    serversRaw && typeof serversRaw === "object" && !Array.isArray(serversRaw)
      ? { ...(serversRaw as Record<string, unknown>) }
      : {}

  const names = hubNames(config)
  for (const name of cleanupNames) names.add(name)
  // Drop hub-managed entries that are disabled or removed from canon.
  for (const key of Object.keys(servers)) {
    if (names.has(key)) {
      const def = config.servers.find((s) => s.name === key)
      if (!def || !def.enabled) delete servers[key]
    }
  }

  for (const s of enabledServers(config)) {
    if (s.transport === "stdio") {
      const entry: Record<string, unknown> = {
        command: s.command,
        args: s.args ?? [],
      }
      const env = envForServer(s, envFor)
      if (env) entry.env = env
      servers[s.name] = entry
    } else if (s.transport === "http" && s.url) {
      // Claude project .mcp.json primarily documents stdio; still write url form.
      const entry: Record<string, unknown> = { url: s.url }
      const env = envForServer(s, envFor)
      if (env) entry.env = env
      servers[s.name] = entry
    }
  }

  const next = { ...existing, mcpServers: servers }
  await writeFileAtomic(file, JSON.stringify(next, null, 2) + "\n")
  return file
}

/** Codex: marker block inside `<cwd>/.codex/config.toml`. */
export async function materializeCodex(
  root: string,
  config: McpProjectConfig,
  envFor: EnvLookup,
): Promise<string> {
  const dir = join(root, ".codex")
  const file = join(dir, "config.toml")
  let text = ""
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if (!isEnoent(e)) throw e
  }

  const block = buildCodexBlock(enabledServers(config), envFor)
  const next = replaceMarkerBlock(text, block)
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(file, next)
  return file
}

/**
 * Grok: same `[mcp_servers.*]` TOML as Codex in `<cwd>/.grok/config.toml`.
 * Grok's own `grok mcp add` writes an `enabled` flag per server, so the block
 * carries it too — a server without it still loads, but `grok mcp list` and the
 * CLI's enable/disable pair expect the key to be there.
 */
export async function materializeGrok(
  root: string,
  config: McpProjectConfig,
  envFor: EnvLookup,
): Promise<string> {
  const dir = join(root, ".grok")
  const file = join(dir, "config.toml")
  let text = ""
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if (!isEnoent(e)) throw e
  }

  const block = buildGrokBlock(enabledServers(config), envFor)
  const next = replaceMarkerBlock(text, block)
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(file, next)
  return file
}

export function buildCodexBlock(
  servers: McpServerDef[],
  envFor: EnvLookup,
): string {
  return buildServerTomlBlock(servers, envFor, false)
}

export function buildGrokBlock(
  servers: McpServerDef[],
  envFor: EnvLookup,
): string {
  return buildServerTomlBlock(servers, envFor, true)
}

function buildServerTomlBlock(
  servers: McpServerDef[],
  envFor: EnvLookup,
  withEnabledFlag: boolean,
): string {
  const lines: string[] = [CODEX_BEGIN, "# Managed by Chat Hub — do not edit by hand"]
  for (const s of servers) {
    if (s.transport !== "stdio" || !s.command) continue
    lines.push(`[mcp_servers.${tomlKey(s.name)}]`)
    lines.push(`command = ${tomlString(s.command)}`)
    if (s.args.length > 0) {
      lines.push(`args = [${s.args.map(tomlString).join(", ")}]`)
    }
    if (withEnabledFlag) {
      lines.push("enabled = true")
    }
    const env = envForServer(s, envFor)
    if (env) {
      lines.push(`[mcp_servers.${tomlKey(s.name)}.env]`)
      for (const [k, v] of Object.entries(env)) {
        lines.push(`${tomlKey(k)} = ${tomlString(v)}`)
      }
    }
    lines.push("")
  }
  lines.push(CODEX_END)
  return lines.join("\n") + "\n"
}

export function replaceMarkerBlock(source: string, block: string): string {
  const begin = source.indexOf(CODEX_BEGIN)
  const end = source.indexOf(CODEX_END)
  if (begin !== -1 && end !== -1 && end > begin) {
    const afterEnd = end + CODEX_END.length
    // Consume trailing newline after END so we don't stack blanks.
    let tailStart = afterEnd
    if (source[tailStart] === "\r") tailStart += 1
    if (source[tailStart] === "\n") tailStart += 1
    const head = source.slice(0, begin).replace(/\s*$/, "")
    const tail = source.slice(tailStart)
    const mid = block.endsWith("\n") ? block : block + "\n"
    if (!head) return mid + (tail.startsWith("\n") ? tail : tail ? "\n" + tail : "")
    return head + "\n\n" + mid + (tail ? (tail.startsWith("\n") ? tail : "\n" + tail) : "")
  }
  if (!source.trim()) return block.endsWith("\n") ? block : block + "\n"
  const sep = source.endsWith("\n") ? "\n" : "\n\n"
  return source.replace(/\s*$/, "") + sep + (block.endsWith("\n") ? block : block + "\n")
}

function tomlString(v: string): string {
  return JSON.stringify(v)
}

/** OpenCode: merge `mcp` key in `<cwd>/opencode.json`. */
export async function materializeOpenCode(
  root: string,
  config: McpProjectConfig,
  envFor: EnvLookup,
  cleanupNames: Iterable<string> = [],
): Promise<string | null> {
  const file = join(root, "opencode.json")
  const enabled = enabledServers(config)
  let existing: Record<string, unknown> | null = null
  try {
    const text = await readFile(file, "utf8")
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch (e) {
    if (!isEnoent(e)) throw e
  }

  if (!existing && enabled.length === 0) {
    // Do not create an empty opencode.json.
    return null
  }

  const base: Record<string, unknown> = existing ? { ...existing } : {}
  const prevMcp =
    base.mcp && typeof base.mcp === "object" && !Array.isArray(base.mcp)
      ? { ...(base.mcp as Record<string, unknown>) }
      : {}

  const names = hubNames(config)
  for (const name of cleanupNames) names.add(name)
  for (const key of Object.keys(prevMcp)) {
    if (names.has(key)) {
      const def = config.servers.find((s) => s.name === key)
      if (!def || !def.enabled) delete prevMcp[key]
    }
  }

  for (const s of enabled) {
    if (s.transport === "stdio" && s.command) {
      const entry: Record<string, unknown> = {
        type: "local",
        enabled: true,
        command: [s.command, ...(s.args ?? [])],
      }
      const env = envForServer(s, envFor)
      if (env) entry.environment = env
      prevMcp[s.name] = entry
    } else if (s.transport === "http" && s.url) {
      const entry: Record<string, unknown> = {
        type: "remote",
        enabled: true,
        url: s.url,
      }
      const env = envForServer(s, envFor)
      if (env) entry.environment = env
      prevMcp[s.name] = entry
    }
  }

  base.mcp = prevMcp
  await writeFileAtomic(file, JSON.stringify(base, null, 2) + "\n")
  return file
}

/** Used by tests that need a real write without going through electron. */
export async function writeText(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, "utf8")
}
