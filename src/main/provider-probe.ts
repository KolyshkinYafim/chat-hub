import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { accessSync, constants } from "node:fs"
import { findBinary } from "./adapters/binary"
import type { ProviderId } from "@shared/types"
import type {
  AuthState,
  ModelInfo,
  ProviderConfig,
  ProviderStatus,
} from "@shared/settings-types"

const execFileAsync = promisify(execFile)

const META: Record<
  ProviderId,
  {
    label: string
    names: string[]
    loginCommand: string | null
    docsUrl: string | null
  }
> = {
  claude: {
    label: "Claude Code",
    names: ["claude"],
    loginCommand: "claude auth login",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
  },
  grok: {
    label: "Grok Build",
    names: ["grok", `${process.env.HOME}/.grok/bin/grok`],
    loginCommand: "grok login",
    docsUrl: null,
  },
  opencode: {
    label: "OpenCode",
    names: ["opencode"],
    loginCommand: "opencode auth login",
    docsUrl: "https://opencode.ai",
  },
  codex: {
    label: "Codex CLI",
    names: ["codex"],
    loginCommand: "codex login",
    docsUrl: null,
  },
  mock: {
    label: "Mock",
    names: [],
    loginCommand: null,
    docsUrl: null,
  },
}

const CLAUDE_MODELS: ModelInfo[] = [
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "opus", label: "Opus (latest)" },
  { id: "haiku", label: "Haiku (latest)" },
]

const GROK_MODELS: ModelInfo[] = [
  { id: "grok-4", label: "Grok 4" },
  { id: "grok-3", label: "Grok 3" },
  { id: "grok-code", label: "Grok Code" },
]

const CODEX_MODELS: ModelInfo[] = [
  { id: "o3", label: "o3" },
  { id: "o4-mini", label: "o4-mini" },
  { id: "gpt-5", label: "GPT-5" },
]

function resolveBinary(
  id: ProviderId,
  config: ProviderConfig,
): string | null {
  if (config.binaryPath) {
    try {
      accessSync(config.binaryPath, constants.X_OK)
      return config.binaryPath
    } catch {
      return null
    }
  }
  if (id === "mock") return "mock"
  return findBinary(META[id].names)
}

async function run(
  bin: string,
  args: string[],
  timeout = 8000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    })
    return {
      ok: true,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
    }
  } catch (err) {
    const e = err as {
      stdout?: string
      stderr?: string
      message?: string
    }
    return {
      ok: false,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
    }
  }
}

async function versionOf(bin: string, id: ProviderId): Promise<string | null> {
  if (id === "mock") return "builtin"
  const attempts = [["--version"], ["-v"], ["version"]]
  for (const args of attempts) {
    const r = await run(bin, args, 4000)
    const text = (r.stdout || r.stderr).trim().split("\n")[0]
    if (text && text.length < 120) return text
  }
  return null
}

async function probeAuth(
  id: ProviderId,
  bin: string | null,
): Promise<{ auth: AuthState; detail: string }> {
  if (id === "mock") {
    return { auth: "n/a", detail: "No account needed" }
  }
  if (!bin) {
    return { auth: "not_installed", detail: "CLI not found on PATH" }
  }

  if (id === "claude") {
    const r = await run(bin, ["auth", "status", "--json"], 10000)
    const raw = r.stdout || r.stderr
    try {
      const j = JSON.parse(raw) as {
        loggedIn?: boolean
        email?: string
        subscriptionType?: string
      }
      if (j.loggedIn) {
        const bits = [j.email, j.subscriptionType].filter(Boolean).join(" · ")
        return {
          auth: "connected",
          detail: bits || "Logged in",
        }
      }
      return { auth: "needs_login", detail: "Not logged in — run claude auth login" }
    } catch {
      if (/logged\s*in|email/i.test(raw) && !/not logged/i.test(raw)) {
        return { auth: "connected", detail: raw.trim().slice(0, 120) }
      }
      return {
        auth: "unknown",
        detail: raw.trim().slice(0, 160) || "Could not parse auth status",
      }
    }
  }

  if (id === "opencode") {
    const r = await run(bin, ["auth", "list"], 10000)
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
    // No stable status command — installed CLI is treated as ready; login if run fails.
    return {
      auth: "unknown",
      detail: "Installed — use Login if API rejects (grok login)",
    }
  }

  if (id === "codex") {
    return {
      auth: "not_installed",
      detail: "Install Codex CLI and run codex login",
    }
  }

  return { auth: "unknown", detail: "" }
}

async function listModels(
  id: ProviderId,
  bin: string | null,
): Promise<ModelInfo[]> {
  if (id === "mock") return [{ id: "mock", label: "Mock" }]
  if (id === "claude") return CLAUDE_MODELS
  if (id === "grok") return GROK_MODELS
  if (id === "codex") return CODEX_MODELS
  if (id === "opencode" && bin) {
    const r = await run(bin, ["models"], 15000)
    const lines = (r.stdout || r.stderr)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("┌") && !l.startsWith("│") && !l.startsWith("└"))
    const models: ModelInfo[] = []
    for (const line of lines) {
      // format: provider/model
      if (line.includes("/") && line.length < 200 && !line.startsWith("opencode ")) {
        models.push({ id: line, label: line })
      }
    }
    return models.length > 0 ? models.slice(0, 80) : []
  }
  return []
}

export async function probeProvider(
  id: ProviderId,
  config: ProviderConfig = {},
): Promise<ProviderStatus> {
  const meta = META[id]
  if (id === "mock") {
    return {
      id,
      label: meta.label,
      installed: true,
      binaryPath: "builtin",
      version: "builtin",
      auth: "n/a",
      authDetail: "UI testing only",
      models: [{ id: "mock", label: "Mock" }],
      defaultModel: "mock",
      loginCommand: null,
      docsUrl: null,
    }
  }

  const binaryPath = resolveBinary(id, config)
  const installed = Boolean(binaryPath)
  const version = binaryPath ? await versionOf(binaryPath, id) : null
  const { auth, detail } = await probeAuth(id, binaryPath)
  const models = await listModels(id, binaryPath)
  const defaultModel =
    config.defaultModel ||
    models[0]?.id ||
    null

  return {
    id,
    label: meta.label,
    installed,
    binaryPath,
    version,
    auth: installed ? auth : "not_installed",
    authDetail: installed ? detail : `Install \`${meta.names[0] ?? id}\` and restart Hub`,
    models,
    defaultModel,
    loginCommand: meta.loginCommand,
    docsUrl: meta.docsUrl,
  }
}

export async function probeAllProviders(
  configs: Partial<Record<ProviderId, ProviderConfig>>,
): Promise<ProviderStatus[]> {
  const ids: ProviderId[] = ["claude", "grok", "opencode", "codex", "mock"]
  return Promise.all(ids.map((id) => probeProvider(id, configs[id] ?? {})))
}

export function resolveBinaryForSpawn(
  id: ProviderId,
  config: ProviderConfig,
): string | null {
  return resolveBinary(id, config)
}
