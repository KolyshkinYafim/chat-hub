import type { PermissionMode } from "./permission"
import type { HookRun } from "./hooks"

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_input"
  | "error"
  | "done"

export type ProviderId = "mock" | "grok" | "claude" | "codex" | "opencode"

export type ProviderInfo = {
  id: ProviderId
  label: string
  available: boolean
  description: string
}

export type SessionMeta = {
  id: string
  title: string
  /**
   * Who named the session. "user" titles are sacred — auto-titling never touches
   * them. Absent (pre-feature sessions): default-looking titles count as
   * "default", anything else as "user".
   */
  titleOrigin?: "default" | "auto" | "user"
  /** Project / folder group in the sidebar (e.g. mary, FinanceApp). */
  project: string
  provider: ProviderId
  /** Provider instance (shadow home). Defaults to the provider id. */
  instanceId?: string
  /** Model id for this session (provider-specific). */
  model?: string
  /**
   * Permission mode for this session only. Absent = follow the global default,
   * so an existing session keeps behaving exactly as it did before it was ever
   * touched, and changing one session's mode never retunes the others.
   */
  permissionMode?: PermissionMode
  /** Active mode preset id (for the composer chip); undefined = no mode. */
  modeId?: string
  /** Resolved system prompt appended every turn — set when a mode is applied. */
  systemPrompt?: string
  /** The CLI's own session id, persisted so multi-turn resume survives restart. */
  agentSessionId?: string
  cwd: string
  /** Original repository folder when this session runs in an isolated worktree. */
  baseCwd?: string
  /** Git branch created for an isolated session. */
  branch?: string
  /** Absolute worktree path, retained for safe cleanup on session deletion. */
  worktreePath?: string
  status: SessionStatus
  /** Set when the thread settled (turn done, nothing pending); cleared on activity. */
  settledAt?: number
  settledBy?: "auto" | "user"
  archived?: boolean
  /**
   * Who owns this session's card on the island: "hub" for one we spawned,
   * "terminal" for one a Claude Code hook reported. The island labels the host
   * from this; leaving it out made it guess from an empty focusApp.
   */
  source?: "hub" | "terminal"
  createdAt: number
  updatedAt: number
}

/** A first-class project the user pins in the sidebar, independent of sessions. */
export type Project = {
  id: string
  name: string
  cwd: string
  createdAt: number
}

export type ChatRole = "user" | "assistant" | "system"

/**
 * What a CLI's result line said this turn cost. Every field is optional and only
 * ever set from a number the CLI actually printed — a missing field means "this
 * agent does not report it", which the UI renders as nothing rather than as 0.
 */
export type TurnUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
  costUsd?: number
  durationMs?: number
  contextWindow?: number
}

/** Running total over every turn of a session that reported usage. */
export type SessionUsage = TurnUsage & {
  turns: number
  lastTurn?: TurnUsage
}

export type TurnItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "declined"
  | "interrupted"

export type TurnPlanStep = {
  text: string
  status: "pending" | "running" | "completed"
}

export type TurnFileChange = {
  path: string
  kind?: string
  diff?: string
}

/**
 * Provider-neutral, persisted agent activity. Final prose remains `content`;
 * everything with a lifecycle is an item so the renderer never has to recover
 * tool state from synthetic Markdown fences.
 */
export type AgentTurnItem =
  | {
      id: string
      kind: "reasoning"
      status: TurnItemStatus
      summary: string
    }
  | {
      id: string
      kind: "plan"
      status: TurnItemStatus
      text: string
      steps?: TurnPlanStep[]
    }
  | {
      id: string
      kind: "command"
      status: TurnItemStatus
      command: string
      cwd?: string
      output?: string
      exitCode?: number
      durationMs?: number
    }
  | {
      id: string
      kind: "file_change"
      status: TurnItemStatus
      changes: TurnFileChange[]
      aggregateDiff?: string
    }
  | {
      id: string
      kind: "tool"
      status: TurnItemStatus
      name: string
      server?: string
      arguments?: unknown
      result?: unknown
      error?: string
      durationMs?: number
    }
  | {
      id: string
      kind: "web_search"
      status: TurnItemStatus
      query: string
    }
  | {
      id: string
      kind: "image"
      status: TurnItemStatus
      path: string
    }
  | {
      id: string
      kind: "review"
      status: TurnItemStatus
      text: string
    }
  | {
      id: string
      kind: "compaction"
      status: TurnItemStatus
    }
  | {
      id: string
      kind: "error"
      status: "failed"
      message: string
    }

/** Persisted reference to a user-supplied file. File bytes never enter state.json. */
export type MessageAttachment = {
  /** Absolute local path passed to the provider. */
  path: string
  /** Display metadata is derived in main after validating the path. */
  name: string
  sizeBytes: number
  kind: "image" | "file"
  mime?: string
}

export type ChatMessage = {
  id: string
  sessionId: string
  role: ChatRole
  content: string
  createdAt: number
  streaming?: boolean
  /** Set on the assistant message once its turn's result line lands. */
  usage?: TurnUsage
  /** Structured agent activity for this assistant turn. */
  items?: AgentTurnItem[]
  /** Structured local-file references for user messages. */
  attachments?: MessageAttachment[]
  /** Git ref snapshotting the working tree just before this user turn ran. */
  checkpointRef?: string
}

/**
 * A follow-up the user wrote while a turn was still running. It is already in
 * the transcript but has not reached the CLI yet, so it stays cancellable.
 */
export type QueuedMessage = {
  id: string
  sessionId: string
  text: string
  createdAt: number
}

export type PermissionDecision = "allow" | "deny"

/** Which surface answered — the Hub transcript, the island, or nobody. */
export type PermissionDecider = "hub" | "island" | "expired" | "gone"

/**
 * A tool permission a Hub-spawned CLI is blocked on. The Hub and the island both
 * render it and either may answer; see docs/permissions.md.
 */
export type PermissionRequestInfo = {
  requestId: string
  /** Hub session it belongs to; null when the agent id matched nothing. */
  sessionId: string | null
  /** The agent's own namespaced id from the hook (e.g. "claude-<uuid>"). */
  agentSessionId: string
  /** Agent that asked, as the hook labels it ("claude", "codex", …). */
  source: string
  summary: string
  toolName?: string
  cwd?: string
  createdAt: number
}

export type AgentInputQuestion = {
  id: string
  header: string
  prompt: string
  options?: { label: string; description?: string }[]
  secret?: boolean
}

export type AgentInputRequestInfo = {
  requestId: string
  sessionId: string
  source: string
  questions: AgentInputQuestion[]
  createdAt: number
}

export type SessionEvent =
  | { type: "session.upsert"; session: SessionMeta }
  | { type: "session.status"; id: string; status: SessionStatus }
  | {
      type: "session.permission"
      id: string
      requestId: string
      summary: string
    }
  | {
      type: "session.question"
      id: string
      requestId: string
      prompt: string
      options?: string[]
    }
  | {
      type: "session.message"
      id: string
      role: ChatRole
      preview: string
    }
  | {
      type: "session.ended"
      id: string
      reason: "done" | "error" | "killed"
    }

export type HubEvent =
  | SessionEvent
  | { type: "chat.message"; message: ChatMessage }
  | {
      type: "chat.delta"
      sessionId: string
      messageId: string
      delta: string
    }
  | {
      type: "chat.item"
      sessionId: string
      messageId: string
      item: AgentTurnItem
    }
  | { type: "chat.done"; sessionId: string; messageId: string }
  | { type: "sessions.replaced"; sessions: SessionMeta[] }
  | {
      type: "messages.replaced"
      sessionId: string
      messages: ChatMessage[]
    }
  | { type: "session.active"; sessionId: string | null }
  | {
      type: "queue.changed"
      sessionId: string
      queued: QueuedMessage[]
    }
  | {
      type: "usage.changed"
      sessionId: string
      /** The assistant message the turn produced, when there was one. */
      messageId?: string
      turn?: TurnUsage
      total: SessionUsage
    }
  | { type: "permission.request"; request: PermissionRequestInfo }
  | {
      type: "permission.resolved"
      requestId: string
      sessionId: string | null
      /** "cancelled" = the asking CLI went away before anyone decided. */
      outcome: PermissionDecision | "cancelled"
      decidedBy: PermissionDecider
    }
  | { type: "input.request"; request: AgentInputRequestInfo }
  | { type: "input.resolved"; requestId: string; sessionId: string }
  /** One project-local hook finished (shell or prompt). See `src/main/hooks.ts`. */
  | { type: "hook.ran"; run: HookRun }

export type CreateSessionInput = {
  provider: ProviderId
  instanceId?: string
  title?: string
  cwd?: string
  project?: string
  model?: string
  /** Start the agent in a dedicated git worktree when the folder is a repo. */
  worktree?: boolean
}

export type SessionSnapshot = {
  sessions: SessionMeta[]
  messages: Record<string, ChatMessage[]>
  /** Undelivered follow-ups per session — the queue survives a renderer reload. */
  queued: Record<string, QueuedMessage[]>
  /** Per-session totals; a session with no reporting CLI is simply absent. */
  usage: Record<string, SessionUsage>
  /** Tool permissions still blocking a CLI, for a renderer that just reloaded. */
  permissions: PermissionRequestInfo[]
  /** Native agent questions still awaiting an answer. */
  inputRequests: AgentInputRequestInfo[]
  activeSessionId: string | null
}

/** A page of transcript history older than the currently loaded tail. */
export type OlderMessagesResult = {
  messages: ChatMessage[]
  hasMore: boolean
}

/** Static fallback; main process returns live availability via listProviders. */
export const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    available: false,
    description: "Detect at runtime",
  },
  {
    id: "grok",
    label: "Grok Build",
    available: false,
    description: "Detect at runtime",
  },
  {
    id: "opencode",
    label: "OpenCode",
    available: false,
    description: "Detect at runtime",
  },
  {
    id: "codex",
    label: "Codex CLI",
    available: false,
    description: "Detect at runtime",
  },
  {
    id: "mock",
    label: "Mock",
    available: true,
    description: "UI testing only",
  },
]

export type GitCheckoutInfo = {
  branch: string
  dirty: boolean
  root: string | null
}

/**
 * One path as `git status --porcelain` sees it. `index`/`work` are the raw two
 * status columns, so a file edited twice (staged then edited again) shows up in
 * both lists of the panel exactly as git reports it — no invented single state.
 */
export type GitFileChange = {
  /** Repo-relative, always the current name (a rename carries `from`). */
  path: string
  from?: string
  /** Staged column: "M", "A", "D", "R", … or " " for nothing staged. */
  index: string
  /** Worktree column: "M", "D", "?" (untracked), … or " ". */
  work: string
}

export type GitWorkingCopy = {
  root: string | null
  branch: string
  /** Commits ahead/behind the tracked upstream; 0/0 when there is none. */
  ahead: number
  behind: number
  files: GitFileChange[]
}

/**
 * Per-path hunk counts of the two textual diffs (index vs HEAD, worktree vs
 * index). Paths with no textual hunks — binary, untracked, renames without
 * edits — simply do not appear.
 */
export type GitHunkSummary = Record<
  string,
  { staged: number; unstaged: number }
>

export type GitBranchList = {
  current: string
  branches: string[]
}

/** One commit as the History surface lists it. */
export type GitLogEntry = {
  sha: string
  shortSha: string
  subject: string
  author: string
  /** Author date, ISO 8601. */
  date: string
  /** Decorations: branch heads, tags, HEAD — empty for an unmarked commit. */
  refs: string[]
}

/** One file's numstat row inside a commit; binary files carry no line counts. */
export type GitCommitFileStat = {
  path: string
  added: number
  removed: number
  binary: boolean
}

export type GitCommitDetail = {
  sha: string
  files: GitCommitFileStat[]
  /** Unified diff of the whole commit, as `git show` prints it. */
  diff: string
}

export type GitRepository = { root: string; name: string; branch: string; dirty: boolean }

/** One checkout registered in a repository's worktree administrative file. */
export type GitWorktreeInfo = {
  path: string
  branch: string
  head: string
  dirty: boolean
  /** The checkout directory no longer exists but Git still has its metadata. */
  prunable: boolean
  bare: boolean
}
