import type { ProviderInfo } from "@shared/types"
import type { ProviderStatus } from "@shared/settings-types"

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
