import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from "@shared/permission"
import { randomUUID } from "node:crypto"
import { PROVIDERS, type ProviderId } from "@shared/types"
import type {
  GeneralConfig,
  HubSettings,
  Mode,
  ProviderConfig,
  ProviderInstance,
  RedactedProviderConfig,
} from "@shared/settings-types"
import { parseThemeDef, type ThemeDef } from "@shared/theme"
import { DEFAULT_WINDOW_ID } from "@shared/window-identity"
import {
  parseWindowState,
  parseWindowStates,
  type PersistedWindow,
  type WindowState,
} from "@shared/window-bounds"
import { clampZoomLevel, DEFAULT_ZOOM_LEVEL } from "@shared/zoom"
import { openSecret, sealSecret } from "./secret"
import { homeEnvFor } from "./instances"
import { quarantineCorrupt, writeFileAtomic } from "./atomic-write"

const PROVIDER_IDS = new Set<string>(PROVIDERS.map((p) => p.id))

const DEFAULTS: HubSettings = {
  version: 2,
  permissionMode: DEFAULT_PERMISSION_MODE,
  providers: {},
  instances: [],
  general: {},
  mcpEnv: {},
}

/** Effective config for spawning/probing one instance (default or extra). */
export type ResolvedInstance = {
  provider: ProviderId
  instanceId: string
  isExtra: boolean
  label: string
  binaryPath?: string
  defaultModel?: string
  enabled: boolean
  homeDir?: string
  /** Decrypted env for spawn (API keys for default, home-env for extras). */
  env: Record<string, string>
}

export class SettingsStore {
  private data: HubSettings = structuredClone(DEFAULTS)

  constructor(private readonly filePath: string) {}

  get snapshot(): HubSettings {
    return structuredClone(this.data)
  }

  get permissionMode(): PermissionMode {
    return this.data.permissionMode
  }

  get general(): GeneralConfig {
    return { ...this.data.general }
  }

  /** Last run's window geometry, or null on a first launch. */
  get windowState(): WindowState | null {
    return this.data.window ? structuredClone(this.data.window) : null
  }

  async setWindowState(state: WindowState): Promise<void> {
    const prev = this.data.window
    this.data = {
      ...this.data,
      window: {
        ...state,
        cockpit: state.cockpit ?? prev?.cockpit,
      },
    }
    await this.save()
  }

  get windowStates(): PersistedWindow[] | null {
    if (this.data.windows && this.data.windows.length > 0) {
      return structuredClone(this.data.windows)
    }
    const legacy = this.windowState
    return legacy ? [{ windowId: DEFAULT_WINDOW_ID, ...legacy }] : null
  }

  async setWindowStates(states: readonly PersistedWindow[]): Promise<void> {
    if (states.length === 0) return
    this.data = { ...this.data, windows: [...states] }
    await this.save()
  }

  get zoomLevel(): number {
    return clampZoomLevel(this.data.zoomLevel ?? DEFAULT_ZOOM_LEVEL)
  }

  async setZoomLevel(level: number): Promise<void> {
    this.data = { ...this.data, zoomLevel: clampZoomLevel(level) }
    await this.save()
  }

  async setGeneralConfig(patch: GeneralConfig): Promise<HubSettings> {
    this.data = {
      ...this.data,
      general: { ...this.data.general, ...patch },
    }
    await this.save()
    return this.snapshot
  }

  getProviderConfig(id: ProviderId): ProviderConfig {
    return { ...(this.data.providers[id] ?? {}) }
  }

  isProviderEnabled(id: ProviderId): boolean {
    return this.data.providers[id]?.enabled !== false
  }

  /** Env var names set for a provider (values stay sealed). */
  getProviderEnvKeys(id: ProviderId): string[] {
    return Object.keys(this.data.providers[id]?.env ?? {})
  }

  /** Decrypted env for spawning the CLI. Main-process only. */
  getProviderEnv(id: ProviderId): Record<string, string> {
    const sealed = this.data.providers[id]?.env ?? {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(sealed)) {
      const plain = openSecret(v)
      if (plain) out[k] = plain
    }
    return out
  }

  listInstances(): ProviderInstance[] {
    return this.data.instances.map((i) => ({ ...i }))
  }

  async addInstance(
    provider: ProviderId,
    patch: Partial<ProviderInstance>,
  ): Promise<ProviderInstance> {
    const instance: ProviderInstance = {
      id: randomUUID(),
      provider,
      label: patch.label?.trim() || `${provider} (2)`,
      homeDir: patch.homeDir?.trim() || undefined,
      binaryPath: patch.binaryPath?.trim() || undefined,
      defaultModel: patch.defaultModel?.trim() || undefined,
      enabled: patch.enabled,
    }
    this.data = {
      ...this.data,
      instances: [...this.data.instances, instance],
    }
    await this.save()
    return instance
  }

  async updateInstance(
    id: string,
    patch: Partial<ProviderInstance>,
  ): Promise<ProviderInstance | null> {
    let updated: ProviderInstance | null = null
    this.data = {
      ...this.data,
      instances: this.data.instances.map((i) => {
        if (i.id !== id) return i
        updated = {
          ...i,
          label: patch.label !== undefined ? patch.label.trim() || i.label : i.label,
          homeDir:
            patch.homeDir !== undefined ? patch.homeDir.trim() || undefined : i.homeDir,
          binaryPath:
            patch.binaryPath !== undefined
              ? patch.binaryPath.trim() || undefined
              : i.binaryPath,
          defaultModel:
            patch.defaultModel !== undefined
              ? patch.defaultModel.trim() || undefined
              : i.defaultModel,
          enabled: patch.enabled !== undefined ? patch.enabled : i.enabled,
        }
        return updated
      }),
    }
    await this.save()
    return updated
  }

  async removeInstance(id: string): Promise<ProviderInstance[]> {
    this.data = {
      ...this.data,
      instances: this.data.instances.filter((i) => i.id !== id),
    }
    await this.save()
    return this.listInstances()
  }

  /** Resolve one instance (default = provider id, or an extra) for spawn/probe. */
  resolveInstance(instanceId: string | undefined): ResolvedInstance | null {
    const extra = instanceId
      ? this.data.instances.find((i) => i.id === instanceId)
      : undefined
    if (extra) {
      return {
        provider: extra.provider,
        instanceId: extra.id,
        isExtra: true,
        label: extra.label,
        binaryPath: extra.binaryPath,
        defaultModel: extra.defaultModel,
        enabled: extra.enabled !== false,
        homeDir: extra.homeDir,
        env: homeEnvFor(extra.provider, extra.homeDir),
      }
    }
    // Default instance: id is the provider id. A removed extra's uuid must not
    // land here — that silently re-points its sessions at the personal account.
    if (!instanceId || !PROVIDER_IDS.has(instanceId)) return null
    const provider = instanceId as ProviderId
    const cfg = this.data.providers[provider] ?? {}
    return {
      provider,
      instanceId: provider,
      isExtra: false,
      label: provider,
      binaryPath: cfg.binaryPath,
      defaultModel: cfg.defaultModel,
      enabled: cfg.enabled !== false,
      homeDir: undefined,
      env: this.getProviderEnv(provider),
    }
  }

  /** Providers with secrets stripped — safe to hand to the renderer. */
  redactedProviders(): Partial<Record<ProviderId, RedactedProviderConfig>> {
    const out: Partial<Record<ProviderId, RedactedProviderConfig>> = {}
    for (const [id, cfg] of Object.entries(this.data.providers)) {
      if (!cfg) continue
      out[id as ProviderId] = {
        binaryPath: cfg.binaryPath,
        defaultModel: cfg.defaultModel,
        enabled: cfg.enabled,
      }
    }
    return out
  }

  async load(): Promise<HubSettings> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch {
      this.data = structuredClone(DEFAULTS)
      return this.snapshot
    }
    try {
      const parsed = JSON.parse(raw) as Partial<HubSettings> & {
        version?: number
      }
      this.data = {
        version: 2,
        permissionMode: isMode(parsed.permissionMode)
          ? parsed.permissionMode
          : DEFAULT_PERMISSION_MODE,
        providers:
          parsed.providers && typeof parsed.providers === "object"
            ? (parsed.providers as HubSettings["providers"])
            : {},
        instances: Array.isArray(parsed.instances)
          ? (parsed.instances as ProviderInstance[]).filter(
              (i) => i && typeof i.id === "string" && typeof i.provider === "string",
            )
          : [],
        general:
          parsed.general && typeof parsed.general === "object"
            ? (parsed.general as GeneralConfig)
            : {},
        mcpEnv: coerceMcpEnv(parsed.mcpEnv),
        window: parseWindowState(parsed.window) ?? undefined,
        windows: parseWindowStates(parsed.windows) ?? undefined,
        zoomLevel:
          typeof parsed.zoomLevel === "number"
            ? clampZoomLevel(parsed.zoomLevel)
            : undefined,
      }
    } catch (err) {
      // Defaults here mean losing every sealed API key: park the file first so the
      // user can still recover it by hand.
      const parked = await quarantineCorrupt(this.filePath)
      console.error("[settings] unreadable settings parked at", parked, err)
      this.data = structuredClone(DEFAULTS)
    }
    return this.snapshot
  }

  async setPermissionMode(mode: PermissionMode): Promise<HubSettings> {
    this.data = { ...this.data, permissionMode: mode }
    await this.save()
    return this.snapshot
  }

  async setProviderConfig(
    id: ProviderId,
    patch: ProviderConfig,
  ): Promise<HubSettings> {
    const prev = this.data.providers[id] ?? {}

    // Merge env: empty value deletes the key, otherwise seal + store.
    let env = prev.env
    if (patch.env !== undefined) {
      const next: Record<string, string> = { ...(prev.env ?? {}) }
      for (const [rawKey, rawVal] of Object.entries(patch.env)) {
        const key = rawKey.trim()
        if (!key) continue
        if (rawVal === "" || rawVal == null) {
          delete next[key]
        } else {
          next[key] = sealSecret(String(rawVal))
        }
      }
      env = Object.keys(next).length > 0 ? next : undefined
    }

    this.data = {
      ...this.data,
      providers: {
        ...this.data.providers,
        [id]: {
          ...prev,
          binaryPath:
            patch.binaryPath !== undefined
              ? patch.binaryPath.trim() || undefined
              : prev.binaryPath,
          defaultModel:
            patch.defaultModel !== undefined
              ? patch.defaultModel.trim() || undefined
              : prev.defaultModel,
          enabled:
            patch.enabled !== undefined ? patch.enabled : prev.enabled,
          env,
        },
      },
    }
    await this.save()
    return this.snapshot
  }

  /** Env var names stored for an MCP server (values stay sealed). */
  getMcpEnvKeys(serverId: string): string[] {
    return Object.keys(this.data.mcpEnv?.[serverId] ?? {})
  }

  /** Decrypted env for materializing native CLI configs. Main-process only. */
  getMcpEnv(serverId: string): Record<string, string> {
    const sealed = this.data.mcpEnv?.[serverId] ?? {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(sealed)) {
      const plain = openSecret(v)
      if (plain) out[k] = plain
    }
    return out
  }

  /**
   * Merge env for one MCP server. Empty string deletes the key; otherwise seal.
   * Returns the key names now present (never values).
   */
  async setMcpServerEnv(
    serverId: string,
    envPatch: Record<string, string>,
  ): Promise<string[]> {
    const id = serverId.trim()
    if (!id) throw new Error("MCP server id required")
    const all = { ...(this.data.mcpEnv ?? {}) }
    const prev = { ...(all[id] ?? {}) }
    for (const [rawKey, rawVal] of Object.entries(envPatch)) {
      const key = rawKey.trim()
      if (!key) continue
      if (rawVal === "" || rawVal == null) {
        delete prev[key]
      } else {
        prev[key] = sealSecret(String(rawVal))
      }
    }
    if (Object.keys(prev).length === 0) delete all[id]
    else all[id] = prev
    this.data = { ...this.data, mcpEnv: all }
    await this.save()
    return Object.keys(prev)
  }

  /** Remove every sealed env value belonging to a deleted MCP server. */
  async removeMcpServerEnv(serverId: string): Promise<void> {
    const id = serverId.trim()
    if (!id || !this.data.mcpEnv?.[id]) return
    const all = { ...this.data.mcpEnv }
    delete all[id]
    this.data = { ...this.data, mcpEnv: all }
    await this.save()
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify(this.data, null, 2))
  }

  static defaultPath(userData: string): string {
    return join(userData, "data", "settings.json")
  }
}

function isMode(v: unknown): v is PermissionMode {
  return v === "yolo" || v === "acceptEdits" || v === "default"
}

const EFFORT_LEVELS = new Set<string>(["low", "medium", "high", "xhigh", "max", "ultra"])
const EDITOR_PREFS = new Set<string>(["auto", "cursor", "code", "finder"])

export function sanitizeGeneralPatch(patch: unknown): GeneralConfig {
  if (!patch || typeof patch !== "object") throw new Error("Invalid general")
  const p = patch as GeneralConfig
  const clean: GeneralConfig = {}
  if (p.defaultProvider !== undefined) {
    if (!PROVIDER_IDS.has(p.defaultProvider)) throw new Error("Unknown provider")
    clean.defaultProvider = p.defaultProvider
  }
  if (p.defaultEffort !== undefined) {
    if (!EFFORT_LEVELS.has(p.defaultEffort)) throw new Error("Invalid effort")
    clean.defaultEffort = p.defaultEffort
  }
  if (p.editor !== undefined) {
    if (!EDITOR_PREFS.has(p.editor)) throw new Error("Invalid editor")
    clean.editor = p.editor
  }
  if (p.onboarded !== undefined) {
    if (typeof p.onboarded !== "boolean") throw new Error("Invalid onboarded")
    clean.onboarded = p.onboarded
  }
  if (p.completionSound !== undefined) {
    if (typeof p.completionSound !== "boolean") {
      throw new Error("Invalid completion sound")
    }
    clean.completionSound = p.completionSound
  }
  if (p.modes !== undefined) {
    if (!Array.isArray(p.modes)) throw new Error("Invalid modes")
    clean.modes = p.modes.map(sanitizeMode)
  }
  if (p.themeId !== undefined) {
    if (typeof p.themeId !== "string" || p.themeId.length > 64) {
      throw new Error("Invalid theme id")
    }
    clean.themeId = p.themeId
  }
  if (p.customThemes !== undefined) {
    if (!Array.isArray(p.customThemes) || p.customThemes.length > 64) {
      throw new Error("Invalid themes")
    }
    const themes: ThemeDef[] = []
    for (const raw of p.customThemes) {
      const parsed = parseThemeDef(raw)
      if (!parsed) throw new Error("Invalid theme")
      themes.push(parsed)
    }
    clean.customThemes = themes
  }
  return clean
}

function sanitizeMode(raw: unknown): Mode {
  if (!raw || typeof raw !== "object") throw new Error("Invalid mode")
  const m = raw as Mode
  if (typeof m.id !== "string" || !m.id) throw new Error("Invalid mode id")
  if (typeof m.name !== "string" || !m.name.trim()) throw new Error("Invalid mode name")
  const clean: Mode = { id: m.id, name: m.name }
  if (m.systemPrompt !== undefined) {
    if (typeof m.systemPrompt !== "string") throw new Error("Invalid mode prompt")
    clean.systemPrompt = m.systemPrompt
  }
  if (m.model !== undefined) {
    if (typeof m.model !== "string") throw new Error("Invalid mode model")
    clean.model = m.model
  }
  if (m.effort !== undefined) {
    if (!EFFORT_LEVELS.has(m.effort)) throw new Error("Invalid mode effort")
    clean.effort = m.effort
  }
  if (m.permissionMode !== undefined) {
    if (!isMode(m.permissionMode)) throw new Error("Invalid mode permission")
    clean.permissionMode = m.permissionMode
  }
  return clean
}

function coerceMcpEnv(
  raw: unknown,
): Record<string, Record<string, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, Record<string, string>> = {}
  for (const [sid, env] of Object.entries(raw as Record<string, unknown>)) {
    if (!sid || !env || typeof env !== "object" || Array.isArray(env)) continue
    const inner: Record<string, string> = {}
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "string") inner[k] = v
    }
    if (Object.keys(inner).length > 0) out[sid] = inner
  }
  return out
}
