import type {
  ChatMessage,
  ProviderId,
  SessionEvent,
  SessionMeta,
  TurnUsage,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"

export type AdapterStartOpts = {
  sessionId: string
  cwd: string
  title?: string
  /** Binary path override from Settings (falls back to PATH detection). */
  binaryPath?: string
  /** Persisted CLI session id to resume a restored session across restarts. */
  resumeId?: string
}

export type EffortLevel = "low" | "medium" | "high" | "max"

export type AdapterSendOpts = {
  permissionMode?: PermissionMode
  model?: string
  effort?: EffortLevel
  /** Mode preset's system prompt — appended to the CLI's own (Claude only). */
  systemPrompt?: string
  /** Absolute file paths to attach (flag or @mention, per CLI — see args.ts). */
  attachments?: string[]
  /** Binary path override from Settings (falls back to PATH detection). */
  binaryPath?: string
  /** Extra environment (decrypted API keys, home overrides) for the CLI. */
  env?: Record<string, string>
}

export type AdapterCallbacks = {
  onSessionEvent: (event: SessionEvent) => void
  onMessage: (message: ChatMessage) => void
  onDelta: (sessionId: string, messageId: string, delta: string) => void
  onStreamDone: (sessionId: string, messageId: string) => void
  /** The CLI reported its own session id — persist it for cross-restart resume. */
  onAgentSession?: (sessionId: string, agentSessionId: string) => void
  /**
   * Cost/tokens for the turn that just ended. Called at most once per turn, and
   * only when the CLI actually printed numbers.
   */
  onUsage?: (
    sessionId: string,
    usage: TurnUsage,
    messageId: string | undefined,
  ) => void
}

export interface AgentAdapter {
  readonly id: ProviderId
  readonly available: boolean
  start(opts: AdapterStartOpts, cb: AdapterCallbacks): Promise<void>
  send(
    sessionId: string,
    message: string,
    cb: AdapterCallbacks,
    opts?: AdapterSendOpts,
  ): Promise<void>
  abort(sessionId: string): Promise<void>
  dispose(sessionId: string): Promise<void>
}

export type CreateSessionResult = {
  session: SessionMeta
}
