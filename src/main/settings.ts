import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from "@shared/permission"

export type HubSettings = {
  version: 1
  permissionMode: PermissionMode
}

const DEFAULTS: HubSettings = {
  version: 1,
  permissionMode: DEFAULT_PERMISSION_MODE,
}

export class SettingsStore {
  private data: HubSettings = { ...DEFAULTS }

  constructor(private readonly filePath: string) {}

  get snapshot(): HubSettings {
    return { ...this.data }
  }

  get permissionMode(): PermissionMode {
    return this.data.permissionMode
  }

  async load(): Promise<HubSettings> {
    try {
      const raw = await readFile(this.filePath, "utf8")
      const parsed = JSON.parse(raw) as Partial<HubSettings>
      this.data = {
        version: 1,
        permissionMode: isMode(parsed.permissionMode)
          ? parsed.permissionMode
          : DEFAULT_PERMISSION_MODE,
      }
    } catch {
      this.data = { ...DEFAULTS }
    }
    return this.snapshot
  }

  async setPermissionMode(mode: PermissionMode): Promise<HubSettings> {
    this.data = { ...this.data, permissionMode: mode }
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
