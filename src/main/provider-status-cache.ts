import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  ProviderStatus,
  ProviderStatusCache,
} from "@shared/settings-types"
import { quarantineCorrupt, writeFileAtomic } from "./atomic-write"

export class ProviderStatusCacheStore {
  private data: ProviderStatusCache | null = null

  constructor(private readonly filePath: string) {}

  get current(): ProviderStatusCache | null {
    return this.data ? structuredClone(this.data) : null
  }

  async load(): Promise<ProviderStatusCache | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, "utf8")
    } catch {
      this.data = null
      return null
    }
    try {
      this.data = coerceProviderStatusCache(JSON.parse(raw)) ?? null
    } catch (err) {
      const parked = await quarantineCorrupt(this.filePath)
      console.warn("[providers] unreadable status cache parked at", parked, err)
      this.data = null
    }
    return this.current
  }

  async set(cache: ProviderStatusCache): Promise<void> {
    this.data = structuredClone(cache)
    await writeFileAtomic(this.filePath, JSON.stringify(cache, null, 2))
  }

  static defaultPath(userData: string): string {
    return join(userData, "data", "provider-status-cache.json")
  }
}

export function coerceProviderStatusCache(
  raw: unknown,
): ProviderStatusCache | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const cache = raw as { statuses?: unknown; cachedAt?: unknown }
  if (!Array.isArray(cache.statuses)) return undefined
  if (typeof cache.cachedAt !== "number" || !Number.isFinite(cache.cachedAt)) {
    return undefined
  }
  const statuses = cache.statuses.filter(
    (item): item is ProviderStatus =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as ProviderStatus).id === "string" &&
      typeof (item as ProviderStatus).instanceId === "string" &&
      Array.isArray((item as ProviderStatus).models),
  )
  return { statuses, cachedAt: cache.cachedAt }
}
