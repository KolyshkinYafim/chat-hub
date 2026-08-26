import type { ProviderId } from "./types"
import type { PermissionMode } from "./permission"
import type { ThemeDef } from "./theme"
import type { WindowState } from "./window-bounds"

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

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
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
  {
    id: "planner",
    name: "Planner",
    systemPrompt:
      "Maintain a project board at `.chathub/board.json` in the workspace root. It is JSON of the shape " +
      '{"todos":[{"id":string,"text":string,"done":boolean,"status":"pending"|"in_progress"|"blocked"|"done"|"cancelled","blockedReason"?:string,"result"?:string,"createdAt":number}],"notes":[{"id":string,"text":string,"createdAt":number}]}. ' +
      "At the start of a task, read it (create it if missing) and add the todos you plan to do. As you work, set status (in_progress / blocked / done) and done:true when finished; put a short blockedReason or result when useful. Append notes about decisions. Keep it current — it is shown live in the Board panel.",
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
  /** Active theme id; unset = Midnight (the stylesheet's own palette). */
  themeId?: string
  /** User-saved themes from the Appearance editor / JSON import. */
  customThemes?: ThemeDef[]
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
  /** Main-window geometry from the last run; refitted to today's displays. */
  window?: WindowState
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
