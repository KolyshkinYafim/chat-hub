import type { ProviderId } from "./types"
import type { PermissionMode } from "./permission"
import type { ThemeDef } from "./theme"
import type { PersistedWindow, WindowState } from "./window-bounds"

export type AuthState =
  | "connected"
  | "needs_login"
  | "not_installed"
  | "unknown"
  | "n/a"

export type ModelInfo = {
  id: string
  label: string
  /** Live provider capabilities; absent for CLIs that do not publish them. */
  reasoningEfforts?: EffortLevel[]
  defaultReasoningEffort?: EffortLevel
}

export type ProviderConfig = {
  /** Override binary path (empty = auto-detect) */
  binaryPath?: string
  baseUrl?: string
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
  baseUrl?: string
  defaultModel?: string
  enabled?: boolean
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
export type EditorPref = "auto" | "cursor" | "code" | "finder"

/**
 * A reusable preset the user can attach to a session: a system prompt (persona /
 * standing instructions) plus optional model / effort / permission defaults.
 * The system prompt reaches each adapter through its native instruction path;
 * model/effort/permission pre-set the session's existing knobs.
 */
export type Mode = {
  id: string
  name: string
  /** Short user-facing promise shown by the session mode picker. */
  description?: string
  /** Appended to the provider's own instructions every turn. */
  systemPrompt?: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
}

/** Seeded presets shown until the user defines their own. */
export const DEFAULT_MODES: Mode[] = [
  {
    id: "code",
    name: "Code",
    description: "Build, edit files, and verify the result.",
    systemPrompt:
      "Work as an implementation partner. Inspect the existing project, make the requested changes, and verify them in proportion to risk. Keep unrelated changes out of the diff.",
    permissionMode: "acceptEdits",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Explore first and propose a concrete plan without editing.",
    systemPrompt:
      "Explore the project and produce a concrete implementation plan with trade-offs and file-level steps. Do not modify files or run destructive commands until the user explicitly asks to implement the plan.",
    effort: "high",
    permissionMode: "default",
  },
  {
    id: "review",
    name: "Review",
    description: "Find bugs and risks without changing the code.",
    systemPrompt:
      "Act as a meticulous senior code reviewer. Do not modify files. Point out bugs, regressions, edge cases, and risky assumptions, citing exact file and line locations. Lead with findings by severity.",
    effort: "high",
    permissionMode: "default",
  },
  {
    id: "ask",
    name: "Ask",
    description: "Explain the project and answer without taking action.",
    systemPrompt:
      "Answer questions and explain the project clearly. You may inspect files when useful, but do not modify files or run destructive commands unless the user explicitly switches to an implementation request.",
    permissionMode: "default",
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
  completionSound?: boolean
  /** User-defined mode presets; falls back to DEFAULT_MODES when unset. */
  modes?: Mode[]
  /** Active theme id; unset = Midnight (the stylesheet's own palette). */
  themeId?: string
  /** User-saved themes from the Appearance editor / JSON import. */
  customThemes?: ThemeDef[]
  allowAgentHubControl?: boolean
  automationServer?: boolean
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
  /**
   * Sealed env values for MCP servers, keyed by server id then env var name.
   * Never sent to the renderer — only key *names* surface via getMcpEnvKeys.
   * Optional so older settings.json loads without a migration bump.
   */
  mcpEnv?: Record<string, Record<string, string>>
  automationToken?: string
  window?: WindowState
  windows?: PersistedWindow[]
  /** Shell zoom step (`1.2 ** level`); absent = 100%. */
  zoomLevel?: number
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

export type ProviderStatusCache = {
  statuses: ProviderStatus[]
  cachedAt: number
}

export type SettingsSnapshot = {
  permissionMode: PermissionMode
  providers: Partial<Record<ProviderId, RedactedProviderConfig>>
  instances: ProviderInstance[]
  general: GeneralConfig
  /** One entry per instance (default + extras), grouped by provider. */
  statuses: ProviderStatus[]
  statusesCachedAt: number | null
}

export type AutomationStatus = {
  enabled: boolean
  port: number | null
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

/**
 * App + build identity, i.e. the first thing a support conversation asks for.
 * `commit` is the short sha packaging/build-app.sh stamped into the bundle; an
 * unpackaged dev run has no stamp and reports "dev".
 */
export type BuildInfo = {
  version: string
  commit: string
  /** ISO build timestamp, null when the running code was never packaged. */
  builtAt: string | null
  packaged: boolean
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
}

/** What the data folder currently holds — sized for the Advanced tab. */
export type StorageStats = {
  dataDirBytes: number
  fileCount: number
  sessionCount: number
  archivedSessionCount: number
  messageCount: number
}
