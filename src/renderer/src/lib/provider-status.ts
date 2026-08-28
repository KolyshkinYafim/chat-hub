import type { ProviderInfo } from "@shared/types"
import type { ProviderStatus } from "@shared/settings-types"

export function formatCheckedAgo(cachedAt: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - cachedAt) / 60_000)
  if (mins < 1) return "checked just now"
  if (mins < 60) return `checked ${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `checked ${hours} h ago`
  return `checked ${Math.floor(hours / 24)} d ago`
}

export function applyStatusesToProviders(
  providers: ProviderInfo[],
  statuses: ProviderStatus[],
): ProviderInfo[] {
  let changed = false
  const next = providers.map((provider) => {
    const status = statuses.find(
      (item) => !item.isExtra && item.id === provider.id,
    )
    if (!status || status.installed === provider.available) return provider
    changed = true
    return { ...provider, available: status.installed }
  })
  return changed ? next : providers
}
