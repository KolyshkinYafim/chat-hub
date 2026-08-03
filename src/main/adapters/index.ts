import type { ProviderId, ProviderInfo } from "@shared/types"
import type { AgentAdapter } from "./types"
import { MockAdapter } from "./mock"
import { ClaudeAdapter } from "./claude"
import { GrokAdapter } from "./grok"
import { OpenCodeAdapter } from "./opencode"
import { CodexAdapter } from "./codex"

const mock = new MockAdapter()
const claude = new ClaudeAdapter()
const grok = new GrokAdapter()
const opencode = new OpenCodeAdapter()
const codex = new CodexAdapter()

const adapters: Record<ProviderId, AgentAdapter & { refresh?: () => void }> = {
  mock,
  claude,
  grok,
  opencode,
  codex,
}

export function getAdapter(id: ProviderId): AgentAdapter {
  const adapter = adapters[id]
  if (!adapter) {
    throw new Error(`Unknown provider: ${String(id)}`)
  }
  return adapter
}

export function refreshProviders(): void {
  for (const a of Object.values(adapters)) {
    a.refresh?.()
  }
}

export function listProviderInfo(): ProviderInfo[] {
  refreshProviders()
  return [
    {
      id: "claude",
      label: "Claude Code",
      available: claude.available,
      description: claude.available
        ? "Real CLI · stream-json · multi-turn resume"
        : "Install `claude` (Claude Code) and sign in",
    },
    {
      id: "grok",
      label: "Grok Build",
      available: grok.available,
      description: grok.available
        ? "Real CLI · streaming-json headless"
        : "Install Grok Build CLI (`grok` on PATH)",
    },
    {
      id: "opencode",
      label: "OpenCode",
      available: opencode.available,
      description: opencode.available
        ? "Real CLI · opencode run --format json"
        : "Install `opencode` CLI",
    },
    {
      id: "codex",
      label: "Codex CLI",
      available: codex.available,
      description: codex.available
        ? "Codex app-server · resumable threads · structured tools"
        : "Install Codex CLI (`codex` on PATH)",
    },
    {
      id: "mock",
      label: "Mock",
      available: true,
      description: "Fake agent for UI testing only",
    },
  ]
}

export function listAdapters(): AgentAdapter[] {
  return Object.values(adapters)
}

export type { AgentAdapter }
