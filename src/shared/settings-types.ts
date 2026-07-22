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
}

export type HubSettings = {
  version: 2
  permissionMode: PermissionMode
  /** Per-provider preferences */
  providers: Partial<Record<ProviderId, ProviderConfig>>
}

export type ProviderStatus = {
  id: ProviderId
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
}

export type SettingsSnapshot = {
  permissionMode: PermissionMode
  providers: Partial<Record<ProviderId, ProviderConfig>>
  statuses: ProviderStatus[]
}
