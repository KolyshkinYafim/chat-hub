import type {
  AgentTurnItem,
  ChatMessage,
  ProviderId,
  ProviderRateLimits,
  SessionEvent,
  SessionMeta,
  TurnUsage,
  PermissionDecision,
  AgentInputQuestion,
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

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra"

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
  /** Add or replace one structured item on an assistant turn. */
  onTurnItem: (
    sessionId: string,
    messageId: string,
    item: AgentTurnItem,
  ) => void
  /** Ask the Hub/island approval surface and suspend the app-server request. */
  onPermissionRequest?: (request: {
    requestId: string
    sessionId: string
    agentSessionId: string
    source: string
    summary: string
    toolName?: string
    cwd?: string
  }) => Promise<PermissionDecision>
  onUserInputRequest?: (request: {
    requestId: string
    sessionId: string
    source: string
    questions: AgentInputQuestion[]
  }) => Promise<Record<string, string[]>>
  onServerRequestResolved?: (requestIds: string[]) => void
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
  /**
   * How much of the account's allowance is gone, whenever the CLI says so.
   * Arrives on its own schedule, including between turns.
   */
  onRateLimits?: (sessionId: string, limits: ProviderRateLimits) => void
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
