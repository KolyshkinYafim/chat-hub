import type { ProviderId } from "@shared/types"
import type { AgentAdapter } from "./types"
import { MockAdapter } from "./mock"
import { PlaceholderAdapter } from "./placeholder"

const adapters: Record<ProviderId, AgentAdapter> = {
  mock: new MockAdapter(),
  grok: new PlaceholderAdapter("grok"),
  claude: new PlaceholderAdapter("claude"),
  codex: new PlaceholderAdapter("codex"),
  opencode: new PlaceholderAdapter("opencode"),
}

export function getAdapter(id: ProviderId): AgentAdapter {
  const adapter = adapters[id]
  if (!adapter) {
    throw new Error(`Unknown provider: ${String(id)}`)
  }
  return adapter
}

export function listAdapters(): AgentAdapter[] {
  return Object.values(adapters)
}

export type { AgentAdapter }
