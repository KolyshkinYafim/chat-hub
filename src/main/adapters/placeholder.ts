import type { ProviderId } from "@shared/types"
import type { AgentAdapter, AdapterCallbacks, AdapterStartOpts } from "./types"

export class PlaceholderAdapter implements AgentAdapter {
  readonly available = false

  constructor(readonly id: Exclude<ProviderId, "mock">) {}

  async start(_opts: AdapterStartOpts, _cb: AdapterCallbacks): Promise<void> {
    throw new Error(
      `Provider "${this.id}" is not implemented yet. Use mock for local UI work.`,
    )
  }

  async send(
    _sessionId: string,
    _message: string,
    _cb: AdapterCallbacks,
  ): Promise<void> {
    throw new Error(`Provider "${this.id}" is not implemented yet.`)
  }

  async abort(_sessionId: string): Promise<void> {}

  async dispose(_sessionId: string): Promise<void> {}
}
