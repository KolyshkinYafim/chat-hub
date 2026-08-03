import type { ProviderId } from "./types"
import type { PermissionMode } from "./permission"

export type AuthState =
  | "connected"
  | "needs_login"
  | "not_installed"
  | "unknown"
  | "n/a"

export type ModelInfo = {
  id: string
  label: string
}

export type ProviderConfig = {
  /** Override binary path (empty = auto-detect) */
  binaryPath?: string
  /** Default model id for new sessions */
  defaultModel?: string
  /** Off = hidden from composer / new-session pickers. undefined = on. */
  enabled?: boolean
  /**
   * Extra environment for the spawned CLI (e.g. API keys).
   * Values are stored OS-keychain-encrypted on disk and NEVER sent to the
   * renderer — the renderer only learns the key names via `envKeys`.
   */
  env?: Record<string, string>
}

/** ProviderConfig with secrets stripped, safe to send to the renderer. */
export type RedactedProviderConfig = {
  binaryPath?: string
  defaultModel?: string
  enabled?: boolean
}

export type EffortLevel = "low" | "medium" | "high" | "max"
export type EditorPref = "auto" | "cursor" | "code" | "finder"

/**
 * A reusable preset the user can attach to a session: a system prompt (persona /
 * standing instructions) plus optional model / effort / permission defaults.
 * Only the system prompt reaches the CLI as `--append-system-prompt` (Claude);
 * model/effort/permission just pre-set the session's existing knobs.
 */
export type Mode = {
  id: string
  name: string
  /** Appended to the CLI's own system prompt every turn (Claude Code only). */
  systemPrompt?: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
}

/** Seeded presets shown until the user defines their own. */
export const DEFAULT_MODES: Mode[] = [
  {
    id: "reviewer",
    name: "Reviewer",
    systemPrompt:
      "Act as a meticulous senior code reviewer. Do not modify files. Point out bugs, edge cases, and risky assumptions, and cite exact file:line locations. Prefer being critical over being agreeable.",
    effort: "high",
    permissionMode: "default",
  },
  {
    id: "quick-fixer",
    name: "Quick fixer",
    systemPrompt:
      "Make the smallest change that fixes the problem. Do not refactor unrelated code, do not add comments unless asked, and keep the diff tight. State what you changed in one line.",
    effort: "low",
  },
  {
    id: "architect",
    name: "Architect",
    systemPrompt:
      "Think before coding. Lay out the approach, trade-offs, and file-level plan first, then implement. Match existing patterns in the codebase over introducing new ones.",
    effort: "high",
  },
]

/** App-wide preferences that are not tied to a single provider. */
export type GeneralConfig = {
  /** Default agent for new sessions (persisted across restarts). */
  defaultProvider?: ProviderId
  /** Default effort chip for the composer. */
  defaultEffort?: EffortLevel
  /** Which editor "Open in editor" launches. */
  editor?: EditorPref
  /** First-run wizard completed/skipped — don't show it again. */
  onboarded?: boolean
  /** User-defined mode presets; falls back to DEFAULT_MODES when unset. */
  modes?: Mode[]
}

/**
 * An extra login/config-home instance of a provider (beyond the default).
 * Its account lives in `homeDir` (injected as CLAUDE_CONFIG_DIR / CODEX_HOME /
 * … at spawn + probe time). No secrets — the shadow home carries the login.
 */
export type ProviderInstance = {
  id: string
  provider: ProviderId
  label: string
  homeDir?: string
  binaryPath?: string
  defaultModel?: string
  enabled?: boolean
}

export type HubSettings = {
  version: 2
  permissionMode: PermissionMode
  /** Per-provider preferences (the default instance of each provider). */
  providers: Partial<Record<ProviderId, ProviderConfig>>
  /** Extra provider instances (shadow homes). */
  instances: ProviderInstance[]
  /** App-wide preferences. */
  general: GeneralConfig
}

/** Env var names a provider commonly reads (surfaced as key/API-key fields). */
export type ProviderEnvHint = {
  key: string
  label: string
}

export type ProviderStatus = {
  id: ProviderId
  /** Instance id — equals the provider id for the default instance. */
  instanceId: string
  /** Config-home for this instance (null for the default). */
  homeDir: string | null
  /** True when this is an extra (removable) instance, not the default. */
  isExtra: boolean
  label: string
  installed: boolean
  binaryPath: string | null
  version: string | null
  auth: AuthState
  /** Human detail: email, "0 credentials", etc. */
  authDetail: string
  models: ModelInfo[]
  defaultModel: string | null
  loginCommand: string | null
  docsUrl: string | null
  /** Whether this provider is offered in pickers. */
  enabled: boolean
  /** Names of env vars currently set for this provider (values redacted). */
  envKeys: string[]
  /** Suggested env vars the user can fill in (API keys, home overrides). */
  envHints: ProviderEnvHint[]
}

export type SettingsSnapshot = {
  permissionMode: PermissionMode
  providers: Partial<Record<ProviderId, RedactedProviderConfig>>
  instances: ProviderInstance[]
  general: GeneralConfig
  /** One entry per instance (default + extras), grouped by provider. */
  statuses: ProviderStatus[]
}

/** Filesystem locations + bridge health for the Advanced/Connections tabs. */
export type DataPaths = {
  dataDir: string
  settingsPath: string
  statePath: string
  projectsPath: string
  bridgePath: string
  bridgeExists: boolean
  bridgeSize: number
  bridgeMtime: number | null
}
