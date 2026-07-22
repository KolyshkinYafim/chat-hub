import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from "@shared/permission"
import type { ProviderId } from "@shared/types"
import type { HubSettings, ProviderConfig } from "@shared/settings-types"

const DEFAULTS: HubSettings = {
  version: 2,
  permissionMode: DEFAULT_PERMISSION_MODE,
  providers: {},
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

  getProviderConfig(id: ProviderId): ProviderConfig {
    return { ...(this.data.providers[id] ?? {}) }
  }

  async load(): Promise<HubSettings> {
    try {
      const raw = await readFile(this.filePath, "utf8")
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
      }
    } catch {
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
    this.data = {
      ...this.data,
      providers: {
        ...this.data.providers,
        [id]: {
          ...prev,
          ...patch,
          binaryPath:
            patch.binaryPath !== undefined
              ? patch.binaryPath.trim() || undefined
              : prev.binaryPath,
          defaultModel:
            patch.defaultModel !== undefined
              ? patch.defaultModel.trim() || undefined
              : prev.defaultModel,
        },
      },
    }
    await this.save()
    return this.snapshot
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8")
    await rename(tmp, this.filePath)
  }

  static defaultPath(userData: string): string {
    return join(userData, "data", "settings.json")
  }
}

function isMode(v: unknown): v is PermissionMode {
  return v === "yolo" || v === "acceptEdits" || v === "default"
}
