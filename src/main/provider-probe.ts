import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { accessSync, constants, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { findBinary } from "./adapters/binary"
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildGrokArgs,
  buildOpenCodeArgs,
} from "./adapters/args"
import { DEFAULT_HOME } from "./instances"
import { CodexAppServerClient } from "./codex-protocol/client"
import type { ModelListResponse } from "./codex-protocol/generated/v2/ModelListResponse"
import type { ProviderId } from "@shared/types"
import type {
  AuthState,
  EffortLevel,
  ModelInfo,
  ProviderEnvHint,
  ProviderStatus,
} from "@shared/settings-types"

const execFileAsync = promisify(execFile)
const HOME = homedir()

/** Extra install locations beyond PATH, per provider. */
const CODEX_EXTRA_PATHS = [
  join(HOME, ".codex", "bin", "codex"),
  join(HOME, ".local", "bin", "codex"),
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/ChatGPT.app/Contents/MacOS/codex",
]

const META: Record<
  ProviderId,
  {
    label: string
    names: string[]
    loginCommand: string | null
    docsUrl: string | null
    envHints: ProviderEnvHint[]
  }
> = {
  claude: {
    label: "Claude Code",
    names: ["claude"],
    loginCommand: "claude auth login",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    envHints: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API key" }],
  },
  grok: {
    label: "Grok Build",
    names: ["grok", join(HOME, ".grok", "bin", "grok")],
    loginCommand: "grok login",
    docsUrl: null,
    envHints: [
      { key: "XAI_API_KEY", label: "xAI API key" },
      { key: "GROK_API_KEY", label: "Grok API key (alt)" },
    ],
  },
  opencode: {
    label: "OpenCode",
    names: ["opencode"],
    loginCommand: "opencode auth login",
    docsUrl: "https://opencode.ai",
    envHints: [
      { key: "OPENAI_API_KEY", label: "OpenAI API key" },
      { key: "ANTHROPIC_API_KEY", label: "Anthropic API key" },
    ],
  },
  codex: {
    label: "Codex CLI",
    names: ["codex", ...CODEX_EXTRA_PATHS],
    loginCommand: "codex login",
    docsUrl: "https://github.com/openai/codex",
    envHints: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }],
  },
  mock: {
    label: "Mock",
    names: [],
    loginCommand: null,
    docsUrl: null,
    envHints: [],
  },
}

const CLAUDE_MODELS: ModelInfo[] = [
  { id: "fable", label: "Fable (latest)" },
  { id: "opus", label: "Opus (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
]

/** Fallback only — `grok models` is the truth (see grokCatalog). */
const GROK_MODELS: ModelInfo[] = [
  { id: "grok-4", label: "Grok 4" },
  { id: "grok-3", label: "Grok 3" },
  { id: "grok-code", label: "Grok Code" },
]

const RETIRED_CODEX_MODEL_IDS = new Set([
  "gpt-5-codex",
  "gpt-5",
  "o4-mini",
  "o3",
  "gpt-5.2",
  "gpt-5.3-codex",
])

/** One instance to probe (no secrets). Default instance: instanceId === provider. */
export type ProbeInput = {
  provider: ProviderId
  instanceId?: string
  isExtra?: boolean
  /** Display label override (for extra instances). */
  label?: string
  binaryPath?: string
  defaultModel?: string
  enabled?: boolean
  /** Env var names set for this instance (drives "API key → connected"). */
  envKeys?: string[]
  /** Spawn env for probing (e.g. CLAUDE_CONFIG_DIR for a shadow home). */
  env?: Record<string, string>
  /** Config-home override; used for credential-file checks. */
  homeDir?: string
}

function resolveBinary(
  provider: ProviderId,
  binaryPath?: string,
): string | null {
  if (binaryPath) {
    try {
      accessSync(binaryPath, constants.X_OK)
      return binaryPath
    } catch {
      return null
    }
  }
  if (provider === "mock") return "mock"
  return findBinary(META[provider].names)
}

/** Config-home dir for an instance (homeDir override, else provider default). */
function configBase(provider: ProviderId, homeDir?: string): string {
  if (homeDir) return homeDir
  const rel = DEFAULT_HOME[provider]
  return rel ? join(HOME, rel) : HOME
}

/** Is an API-key env var set either by the user (Hub) or the ambient env? */
function envKeySet(keys: string[] | undefined, name: string): boolean {
  if (keys?.includes(name)) return true
  return Boolean(process.env[name])
}

async function run(
  bin: string,
  args: string[],
  timeout = 8000,
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const child = execFileAsync(bin, args, {
      timeout,
      env:
        extraEnv && Object.keys(extraEnv).length > 0
          ? { ...process.env, ...extraEnv }
          : process.env,
      maxBuffer: 2 * 1024 * 1024,
    })
    // Every one of these CLIs reads stdin when it is a pipe. Leave it open and
    // claude sits there warning "no stdin data received in 3s" until the probe
    // times out — on a perfectly healthy install.
    child.child.stdin?.end()
    const { stdout, stderr } = await child
    return {
      ok: true,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
    }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
    }
  }
}

async function versionOf(
  bin: string,
  provider: ProviderId,
  env?: Record<string, string>,
): Promise<string | null> {
  if (provider === "mock") return "builtin"
  const attempts = [["--version"], ["-v"], ["version"]]
  for (const args of attempts) {
    const r = await run(bin, args, 4000, env)
    const text = (r.stdout || r.stderr).trim().split("\n")[0]
    if (text && text.length < 120) return text
  }
  return null
}

type GrokCatalog = { models: ModelInfo[]; raw: string }

const grokCatalogCache = new Map<string, { at: number; catalog: GrokCatalog }>()
const GROK_CATALOG_TTL_MS = 60_000

/**
 * `grok models` answers both questions at once — the model list and whether the
 * CLI is authenticated — so run it once per probe burst and share the output.
 */
async function grokCatalog(
  bin: string,
  env?: Record<string, string>,
): Promise<GrokCatalog> {
  const key = `${bin}\0${JSON.stringify(env ?? {})}`
  const hit = grokCatalogCache.get(key)
  if (hit && Date.now() - hit.at < GROK_CATALOG_TTL_MS) return hit.catalog
  const r = await run(bin, ["models"], 15000, env)
  const raw = r.stdout || r.stderr
  const catalog: GrokCatalog = { models: parseGrokModels(raw), raw }
  grokCatalogCache.set(key, { at: Date.now(), catalog })
  return catalog
}

/** Lines look like "  * grok-4.5 (default)" under an "Available models:" header. */
export function parseGrokModels(raw: string): ModelInfo[] {
  const out: ModelInfo[] = []
  let inList = false
  for (const line of raw.split("\n")) {
    const text = line.trim()
    if (!inList) {
      if (/^available models:/i.test(text)) inList = true
      continue
    }
    if (!text) continue
    const m = /^[*\-•]\s*(\S+)/.exec(text)
    if (!m) break
    out.push({ id: m[1], label: m[1] })
  }
  return out
}

async function probeAuth(
  bin: string | null,
  input: ProbeInput,
): Promise<{ auth: AuthState; detail: string }> {
  const id = input.provider
  const env = input.env
  if (id === "mock") return { auth: "n/a", detail: "No account needed" }
  if (!bin) return { auth: "not_installed", detail: "CLI not found on PATH" }

  const base = configBase(id, input.homeDir)

  if (id === "claude") {
    if (envKeySet(input.envKeys, "ANTHROPIC_API_KEY")) {
      return { auth: "connected", detail: "ANTHROPIC_API_KEY set" }
    }
    const r = await run(bin, ["auth", "status", "--json"], 10000, env)
    const raw = r.stdout || r.stderr
    try {
      const j = JSON.parse(raw) as {
        loggedIn?: boolean
        email?: string
        subscriptionType?: string
      }
      if (j.loggedIn) {
        const bits = [j.email, j.subscriptionType].filter(Boolean).join(" · ")
        return { auth: "connected", detail: bits || "Logged in" }
      }
      return { auth: "needs_login", detail: "Not logged in — run claude auth login" }
    } catch {
      if (/logged\s*in|email/i.test(raw) && !/not logged/i.test(raw)) {
        return { auth: "connected", detail: raw.trim().slice(0, 120) }
      }
      if (existsSync(join(base, "credentials.json")) || existsSync(join(base, ".credentials.json"))) {
        return { auth: "connected", detail: `Signed in (${base})` }
      }
      return {
        auth: "unknown",
        detail: raw.trim().slice(0, 160) || "Could not parse auth status",
      }
    }
  }

  if (id === "opencode") {
    if (
      envKeySet(input.envKeys, "OPENAI_API_KEY") ||
      envKeySet(input.envKeys, "ANTHROPIC_API_KEY")
    ) {
      return { auth: "connected", detail: "API key set in Hub/env" }
    }
    const r = await run(bin, ["auth", "list"], 10000, env)
    const text = (r.stdout || r.stderr).trim()
    if (/0 credentials/i.test(text)) {
      return {
        auth: "needs_login",
        detail: "0 credentials — run opencode auth login (or use free models)",
      }
    }
    if (/credentials/i.test(text) || r.ok) {
      return {
        auth: text.length > 0 ? "connected" : "unknown",
        detail: text.split("\n").slice(0, 3).join(" · ").slice(0, 160) || "OK",
      }
    }
    return { auth: "unknown", detail: text.slice(0, 160) || "auth list failed" }
  }

  if (id === "grok") {
    if (
      envKeySet(input.envKeys, "XAI_API_KEY") ||
      envKeySet(input.envKeys, "GROK_API_KEY")
    ) {
      return { auth: "connected", detail: "API key set in Hub/env" }
    }
    // The CLI states its own auth in plain text; trust it over any file guess.
    const { raw } = await grokCatalog(bin, env)
    if (/not authenticated/i.test(raw)) {
      return { auth: "needs_login", detail: "Not authenticated — run grok login" }
    }
    // config.json / user-settings.json are preference files: their presence says
    // nothing about being signed in, so only real credential stores count.
    const creds = ["auth.json", "credentials.json"].map((f) => join(base, f))
    if (creds.some((p) => existsSync(p))) {
      return { auth: "connected", detail: `Signed in (${base})` }
    }
    return { auth: "needs_login", detail: `No API key or login in ${base}` }
  }

  if (id === "codex") {
    if (envKeySet(input.envKeys, "OPENAI_API_KEY")) {
      return { auth: "connected", detail: "OPENAI_API_KEY set" }
    }
    // config.json is written on first run and carries no credentials.
    const creds = [join(base, "auth.json")]
    if (creds.some((p) => existsSync(p))) {
      return { auth: "connected", detail: `Signed in (${base})` }
    }
    return { auth: "needs_login", detail: `Run codex login or set OPENAI_API_KEY` }
  }

  return { auth: "unknown", detail: "" }
}

async function listModels(
  provider: ProviderId,
  bin: string | null,
  env?: Record<string, string>,
): Promise<ModelInfo[]> {
  if (provider === "mock") return [{ id: "mock", label: "Mock" }]
  if (provider === "claude") return CLAUDE_MODELS
  if (provider === "grok") {
    if (!bin) return GROK_MODELS
    const { models } = await grokCatalog(bin, env)
    // The curated ids (grok-4, grok-3…) are not what the CLI accepts any more.
    return models.length > 0 ? models : GROK_MODELS
  }
  if (provider === "codex") {
    if (!bin) return []
    let client: CodexAppServerClient | undefined
    try {
      client = await CodexAppServerClient.connect({ binary: bin, env })
      const response = await client.request<ModelListResponse>("model/list", {
        limit: 100,
        includeHidden: false,
      })
      const models = response.data
        .filter((model) => !model.hidden && !RETIRED_CODEX_MODEL_IDS.has(model.id))
        .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
        .map((model) => ({
          id: model.id,
          label: model.displayName || model.model,
          reasoningEfforts: model.supportedReasoningEfforts
            .map((option) => option.reasoningEffort)
            .filter(isEffortLevel),
          defaultReasoningEffort: isEffortLevel(model.defaultReasoningEffort)
            ? model.defaultReasoningEffort
            : undefined,
        }))
      return models
    } catch (error) {
      console.warn("[providers] Codex model/list failed", error)
      // An empty picker lets Codex choose its current recommended default. A
      // baked-in list inevitably becomes the stale UI this probe replaces.
      return []
    } finally {
      await client?.close()
    }
  }
  if (provider === "opencode" && bin) {
    const r = await run(bin, ["models"], 15000, env)
    const lines = (r.stdout || r.stderr)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("┌") && !l.startsWith("│") && !l.startsWith("└"))
    const models: ModelInfo[] = []
    for (const line of lines) {
      if (line.includes("/") && line.length < 200 && !line.startsWith("opencode ")) {
        models.push({ id: line, label: line })
      }
    }
    return models.length > 0 ? models.slice(0, 80) : []
  }
  return []
}

export function pickAvailableModel(
  configuredModel: string | undefined,
  models: ModelInfo[],
): string | null {
  const configured = configuredModel?.trim()
  return configured && models.some((model) => model.id === configured)
    ? configured
    : models[0]?.id ?? null
}

function isEffortLevel(value: string): value is EffortLevel {
  return ["low", "medium", "high", "xhigh", "max", "ultra"].includes(value)
}

export async function probeProvider(input: ProbeInput): Promise<ProviderStatus> {
  const id = input.provider
  const meta = META[id]
  const instanceId = input.instanceId ?? id
  const isExtra = input.isExtra ?? false
  const enabled = input.enabled !== false
  const envKeys = input.envKeys ?? []
  const label = input.label ?? meta.label

  if (id === "mock") {
    return {
      id,
      instanceId,
      homeDir: input.homeDir ?? null,
      isExtra,
      label,
      installed: true,
      binaryPath: "builtin",
      version: "builtin",
      auth: "n/a",
      authDetail: "UI testing only",
      models: [{ id: "mock", label: "Mock" }],
      defaultModel: "mock",
      loginCommand: null,
      docsUrl: null,
      enabled,
      envKeys,
      envHints: meta.envHints,
    }
  }

  const binaryPath = resolveBinary(id, input.binaryPath)
  const installed = Boolean(binaryPath)
  const version = binaryPath ? await versionOf(binaryPath, id, input.env) : null
  const { auth, detail } = await probeAuth(binaryPath, input)
  const models = await listModels(id, binaryPath, input.env)
  // Never keep a removed model selected just because it was persisted by an
  // older Chat Hub build. The live catalog is authoritative.
  const defaultModel = pickAvailableModel(input.defaultModel, models)

  return {
    id,
    instanceId,
    homeDir: input.homeDir ?? null,
    isExtra,
    label,
    installed,
    binaryPath,
    version,
    auth: installed ? auth : "not_installed",
    authDetail: installed
      ? detail
      : `Install \`${meta.names[0] ?? id}\` and restart Hub`,
    models,
    defaultModel,
    loginCommand: meta.loginCommand,
    docsUrl: meta.docsUrl,
    enabled,
    envKeys,
    envHints: meta.envHints,
  }
}

export async function probeAllProviders(
  inputs: ProbeInput[],
): Promise<ProviderStatus[]> {
  return Promise.all(inputs.map((i) => probeProvider(i)))
}

export function resolveBinaryForSpawn(
  provider: ProviderId,
  binaryPath?: string,
): string | null {
  return resolveBinary(provider, binaryPath)
}

export type TestResult = { ok: boolean; detail: string; ms: number }

/** The one-line question the connection test asks the model. */
export const TEST_PROMPT = "Reply with just: OK"

/**
 * Argv for "Test connection", built by the same builders production uses.
 * Keeping this exported also makes the security-sensitive read-only probe
 * contract directly testable.
 */
export function buildTestArgs(
  provider: ProviderId,
  opts: { cwd?: string; model?: string } = {},
): string[] | null {
  const input = {
    message: TEST_PROMPT,
    cwd: opts.cwd ?? HOME,
    permissionMode: "default" as const,
    model: opts.model,
  }
  switch (provider) {
    case "claude": return buildClaudeArgs({ ...input, model: input.model ?? "haiku" })
    case "grok": return buildGrokArgs(input)
    case "opencode": return buildOpenCodeArgs(input)
    case "codex": return buildCodexArgs(input)
    default: return null
  }
}

/**
 * Real end-to-end connection test: actually invoke the CLI with a tiny prompt
 * and check we get a response. Validates binary + auth + model + network in one
 * shot (unlike probeAuth). User-initiated. `env` includes any shadow-home vars.
 */
export async function testProvider(
  input: ProbeInput,
  env?: Record<string, string>,
): Promise<TestResult> {
  const started = nowSafe()
  const done = (ok: boolean, detail: string): TestResult => ({
    ok,
    detail,
    ms: Math.max(0, nowSafe() - started),
  })

  const id = input.provider
  if (id === "mock") return done(true, "Built-in mock — always OK")

  const bin = resolveBinary(id, input.binaryPath)
  if (!bin) return done(false, "CLI not found — set a binary path in Settings")

  const args = buildTestArgs(id, { model: input.defaultModel })
  if (!args) return done(false, "No test for this provider")

  const spawnEnv = { ...(env ?? {}), ...(input.env ?? {}) }
  const r = await run(bin, args, 30000, spawnEnv)
  const out = (r.stdout || r.stderr).trim()
  if (r.ok) {
    const snippet = (readableAnswer(r.stdout) ?? out).replace(/\s+/g, " ").slice(0, 120)
    return done(true, snippet ? `Responded: ${snippet}` : "Responded OK")
  }
  // A CLI that answers "Not logged in · Please run /login" inside a well-formed
  // result line is the common case, and dumping the raw JSON at the user hides
  // the one sentence that tells them what to do.
  const reason = readableFailure(r.stdout) ?? readableFailure(r.stderr)
  if (reason) return done(false, reason.slice(0, 200))

  const errTail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")
  return done(false, errTail.slice(0, 200) || "No response (timed out or failed)")
}

function nowSafe(): number {
  return Date.now()
}

/** Last model utterance from a JSON/NDJSON connection-test stream. */
export function readableAnswer(raw: string): string | null {
  let last: string | null = null
  for (const line of (raw ?? "").split("\n")) {
    const text = line.trim()
    if (!text.startsWith("{")) continue
    try {
      const event = JSON.parse(text) as Record<string, unknown>
      const item = event.item
      if (item && typeof item === "object") {
        const value = (item as Record<string, unknown>).text
        if (typeof value === "string" && value.trim()) last = value.trim()
        continue
      }
      for (const key of ["result", "text", "message", "content"]) {
        const value = event[key]
        if (typeof value === "string" && value.trim()) {
          last = value.trim()
          break
        }
      }
    } catch {
      // Plain text falls through to the caller's raw-output fallback.
    }
  }
  return last
}

/** Pull the human sentence out of a CLI's JSON/NDJSON failure line. */
export function readableFailure(raw: string): string | null {
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      const o = JSON.parse(t) as Record<string, unknown>
      for (const key of ["result", "error", "message", "detail"]) {
        const v = o[key]
        if (typeof v === "string" && v.trim()) return v.trim()
        if (v && typeof v === "object") {
          const m = (v as Record<string, unknown>).message
          if (typeof m === "string" && m.trim()) return m.trim()
        }
      }
    } catch {
      // Not a JSON line — the plain-text fallback in the caller handles it.
    }
  }
  return null
}
