import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron"
import { IpcChannels } from "@shared/ipc"
import { parseWindowIntent } from "@shared/window-identity"
import type {
  CreateSessionInput,
  GitBranchList,
  GitCheckoutInfo,
  GitCommitDetail,
  GitHunkSummary,
  GitLogEntry,
  GitPrStatus,
  GitWorkingCopy,
  GitRepository,
  GitWorktreeInfo,
  HubEvent,
  MessageAttachment,
  PermissionRequestInfo,
  Project,
  ProviderId,
  ProviderInfo,
  QueueMoveDirection,
  QueuedMessage,
  SessionMeta,
  SessionSnapshot,
  ChatMessage,
  UsageSummary,
} from "@shared/types"
import type { ArchiveSearchResult } from "@shared/search"
import type { PermissionMode } from "@shared/permission"
import type {
  Board,
  DirEntry,
  DirListing,
  FileContents,
  FileSaved,
  FileStamp,
  OpenedFile,
  ProjectSearchHit,
  TerminalChunk,
  TerminalExit,
  TerminalHandle,
} from "@shared/surfaces"
import type {
  BuildInfo,
  DataPaths,
  GeneralConfig,
  ProviderConfig,
  ProviderInstance,
  ProviderStatus,
  SettingsSnapshot,
  StorageStats,
} from "@shared/settings-types"
import type {
  McpGitignoreResult,
  McpListResult,
  McpMaterializeResult,
  McpServerDef,
  McpServerStatus,
} from "@shared/mcp"
import type { BrowserActivity } from "@shared/browser"
import type {
  SurfaceOpenRequest,
  SurfaceStateReport,
} from "@shared/surface-control"
import type { HubLayoutCommand } from "@shared/hub-control"
import type { ProjectScript, ScriptsFile } from "@shared/scripts"
import type { ContextDocId, ProjectContext } from "@shared/project-context"

const windowIntent = parseWindowIntent(
  (globalThis as { location?: { search?: string } }).location?.search ?? "",
)

const cockpit =
  process.argv.includes("--chat-hub-cockpit=1") ||
  process.argv.includes("--chat-hub-cockpit")

const api = {
  windowIntent,
  cockpit,
  platform: process.platform,
  setCockpit: (enabled: boolean): Promise<{ enabled: boolean }> =>
    ipcRenderer.invoke(IpcChannels.setWindowCockpit, enabled),
  onCockpitChanged: (cb: (enabled: boolean) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, enabled: boolean) => cb(enabled)
    ipcRenderer.on(IpcChannels.cockpitChanged, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.cockpitChanged, handler)
    }
  },
  getSnapshot: (sessionIds?: readonly string[]): Promise<SessionSnapshot> =>
    ipcRenderer.invoke(IpcChannels.getSnapshot, sessionIds),
  listSessions: (): Promise<SessionMeta[]> =>
    ipcRenderer.invoke(IpcChannels.listSessions),
  getMessages: (sessionId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke(IpcChannels.getMessages, sessionId),
  loadArchivedMessages: (
    sessionId: string,
    beforeMessageId: string | null,
    limit?: number,
  ): Promise<{
    messages: ChatMessage[]
    hasMore: boolean
    hasArchive: boolean
  }> =>
    ipcRenderer.invoke(
      IpcChannels.loadArchivedMessages,
      sessionId,
      beforeMessageId,
      limit ?? 50,
    ),
  hasArchivedMessages: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.hasArchivedMessages, sessionId),
  loadArchiveThrough: (
    sessionId: string,
    beforeMessageId: string | null,
    targetMessageId: string,
  ): Promise<{
    messages: ChatMessage[]
    hasMore: boolean
    reachedTarget: boolean
  }> =>
    ipcRenderer.invoke(
      IpcChannels.loadArchiveThrough,
      sessionId,
      beforeMessageId,
      targetMessageId,
    ),
  searchArchivedTranscripts: (
    query: string,
    loadedFrom: Record<string, string | null>,
  ): Promise<ArchiveSearchResult> =>
    ipcRenderer.invoke(
      IpcChannels.searchArchivedTranscripts,
      query,
      loadedFrom,
    ),
  createSession: (input: CreateSessionInput): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.createSession, input),
  sendMessage: (
    sessionId: string,
    text: string,
    opts?: { effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra"; attachments?: string[] },
  ): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.sendMessage, sessionId, text, opts),
  cancelQueued: (
    sessionId: string,
    queuedId: string,
  ): Promise<QueuedMessage[]> =>
    ipcRenderer.invoke(IpcChannels.cancelQueued, sessionId, queuedId),
  editQueued: (
    sessionId: string,
    queuedId: string,
    text: string,
  ): Promise<QueuedMessage[]> =>
    ipcRenderer.invoke(IpcChannels.editQueued, sessionId, queuedId, text),
  reorderQueued: (
    sessionId: string,
    queuedId: string,
    direction: QueueMoveDirection,
  ): Promise<QueuedMessage[]> =>
    ipcRenderer.invoke(IpcChannels.reorderQueued, sessionId, queuedId, direction),
  abortSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.abortSession, sessionId),
  deleteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.deleteSession, sessionId),
  setActiveSession: (
    sessionId: string | null,
  ): Promise<SessionSnapshot> =>
    ipcRenderer.invoke(IpcChannels.setActiveSession, sessionId),
  listProviders: (): Promise<ProviderInfo[]> =>
    ipcRenderer.invoke(IpcChannels.listProviders),
  getBridgePath: (): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.getBridgePath),
  pickFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.pickFolder),
  openPath: (path: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.openPath, path),
  openInEditor: (path: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.openInEditor, path),
  getGitInfo: (cwd: string): Promise<GitCheckoutInfo> =>
    ipcRenderer.invoke(IpcChannels.getGitInfo, cwd),
  gitInit: (cwd: string): Promise<GitCheckoutInfo> =>
    ipcRenderer.invoke(IpcChannels.gitInit, cwd),
  gitCommit: (
    cwd: string,
    message: string,
  ): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitCommit, cwd, message),
  gitStatus: (cwd: string): Promise<GitWorkingCopy> =>
    ipcRenderer.invoke(IpcChannels.gitStatus, cwd),
  gitRepositories: (cwd: string): Promise<GitRepository[]> => ipcRenderer.invoke(IpcChannels.gitRepositories, cwd),
  gitDiff: (
    cwd: string,
    path: string,
    staged: boolean,
    untracked?: boolean,
  ): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.gitDiff, cwd, path, staged, untracked),
  gitStage: (cwd: string, paths: string[]): Promise<GitWorkingCopy> =>
    ipcRenderer.invoke(IpcChannels.gitStage, cwd, paths),
  gitUnstage: (cwd: string, paths: string[]): Promise<GitWorkingCopy> =>
    ipcRenderer.invoke(IpcChannels.gitUnstage, cwd, paths),
  // `hunk` is the full hunk as displayed — header line plus verbatim body —
  // so the main process can refuse anything the user did not actually review.
  gitStageHunk: (
    cwd: string,
    path: string,
    hunkIndex: number,
    hunk: string,
  ): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitStageHunk, cwd, path, hunkIndex, hunk),
  gitUnstageHunk: (
    cwd: string,
    path: string,
    hunkIndex: number,
    hunk: string,
  ): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitUnstageHunk, cwd, path, hunkIndex, hunk),
  gitHunkSummary: (cwd: string): Promise<GitHunkSummary> =>
    ipcRenderer.invoke(IpcChannels.gitHunkSummary, cwd),
  gitBranches: (cwd: string): Promise<GitBranchList> =>
    ipcRenderer.invoke(IpcChannels.gitBranches, cwd),
  gitLog: (cwd: string): Promise<GitLogEntry[]> =>
    ipcRenderer.invoke(IpcChannels.gitLog, cwd),
  gitShow: (cwd: string, sha: string): Promise<GitCommitDetail> =>
    ipcRenderer.invoke(IpcChannels.gitShow, cwd, sha),
  gitCheckout: (
    cwd: string,
    branch: string,
  ): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitCheckout, cwd, branch),
  gitCommitStaged: (
    cwd: string,
    message: string,
  ): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitCommitStaged, cwd, message),
  gitPush: (cwd: string): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitPush, cwd),
  gitCreatePr: (
    cwd: string,
    title: string,
    body: string,
    draft: boolean,
  ): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitCreatePr, cwd, title, body, draft),
  checkpointList: (
    sessionId: string,
  ): Promise<{ ref: string; label: string; createdAt: number }[]> =>
    ipcRenderer.invoke(IpcChannels.checkpointList, sessionId),
  /** Reverts workspace files + transcript; the CLI's own memory keeps the turns. */
  checkpointRevert: (sessionId: string, ref: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.checkpointRevert, sessionId, ref),
  gitWorktrees: (cwd: string): Promise<GitWorktreeInfo[]> =>
    ipcRenderer.invoke(IpcChannels.gitWorktrees, cwd),
  gitRemoveWorktree: (
    repoCwd: string,
    worktreePath: string,
  ): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitRemoveWorktree, repoCwd, worktreePath),
  gitPruneWorktrees: (repoCwd: string): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitPruneWorktrees, repoCwd),
  gitPrStatus: (cwd: string): Promise<GitPrStatus> =>
    ipcRenderer.invoke(IpcChannels.gitPrStatus, cwd),
  gitPrStatuses: (): Promise<Record<string, GitPrStatus>> =>
    ipcRenderer.invoke(IpcChannels.gitPrStatuses),
  gitCheckLog: (cwd: string, runId: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.gitCheckLog, cwd, runId),
  getSettings: (): Promise<SettingsSnapshot> =>
    ipcRenderer.invoke(IpcChannels.getSettings),
  setPermissionMode: (
    mode: PermissionMode,
  ): Promise<{ permissionMode: PermissionMode }> =>
    ipcRenderer.invoke(IpcChannels.setPermissionMode, mode),
  getProviderStatuses: (): Promise<ProviderStatus[]> =>
    ipcRenderer.invoke(IpcChannels.getProviderStatuses),
  setProviderConfig: (
    id: ProviderId,
    patch: ProviderConfig,
  ): Promise<{
    providers: SettingsSnapshot["providers"]
    statuses: ProviderStatus[]
  }> => ipcRenderer.invoke(IpcChannels.setProviderConfig, id, patch),
  providerLogin: (
    instanceId: string,
  ): Promise<{ ok: boolean; command: string }> =>
    ipcRenderer.invoke(IpcChannels.providerLogin, instanceId),
  testProvider: (
    instanceId: string,
  ): Promise<{ ok: boolean; detail: string; ms: number }> =>
    ipcRenderer.invoke(IpcChannels.testProvider, instanceId),
  addInstance: (
    provider: ProviderId,
    patch: Partial<ProviderInstance>,
  ): Promise<{ instances: ProviderInstance[]; statuses: ProviderStatus[] }> =>
    ipcRenderer.invoke(IpcChannels.addInstance, provider, patch),
  updateInstance: (
    id: string,
    patch: Partial<ProviderInstance>,
  ): Promise<{ instances: ProviderInstance[]; statuses: ProviderStatus[] }> =>
    ipcRenderer.invoke(IpcChannels.updateInstance, id, patch),
  removeInstance: (
    id: string,
  ): Promise<{ instances: ProviderInstance[]; statuses: ProviderStatus[] }> =>
    ipcRenderer.invoke(IpcChannels.removeInstance, id),
  setSessionModel: (sessionId: string, model: string): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.setSessionModel, sessionId, model),
  applySessionMode: (
    sessionId: string,
    patch: {
      modeId?: string
      systemPrompt?: string
      model?: string
      permissionMode?: PermissionMode
    },
  ): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.applySessionMode, sessionId, patch),
  /** `undefined` clears the override and follows the global default again. */
  setSessionPermission: (
    sessionId: string,
    mode: PermissionMode | undefined,
  ): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.setSessionPermission, sessionId, mode),
  setSessionSettled: (
    sessionId: string,
    settled: boolean,
  ): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.sessionSetSettled, sessionId, settled),
  setSessionFavorite: (
    sessionId: string,
    favorite: boolean,
  ): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.sessionSetFavorite, sessionId, favorite),
  setSessionArchived: (
    sessionId: string,
    archived: boolean,
  ): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.sessionSetArchived, sessionId, archived),
  /** One-shot push of the legacy localStorage archive ids into main. */
  migrateArchived: (ids: string[]): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.sessionMigrateArchived, ids),
  /** Marks the title user-owned so auto-titling never overwrites it. */
  renameSession: (sessionId: string, title: string): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.sessionRename, sessionId, title),
  /** Fresh LLM title pass; resolves with the (possibly unchanged) session. */
  regenerateTitle: (sessionId: string): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.sessionRegenerateTitle, sessionId),
  pickFiles: (): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.pickFiles),
  inspectAttachments: (paths: string[]): Promise<MessageAttachment[]> =>
    ipcRenderer.invoke(IpcChannels.inspectAttachments, paths),
  /** Resolve a dropped browser File without exposing Node APIs to the renderer. */
  getPathForDroppedFile: (
    file: Parameters<typeof webUtils.getPathForFile>[0],
  ): string => webUtils.getPathForFile(file),
  /** Persist a pasted/dropped image blob to disk; returns its absolute path so
   *  the composer can attach it exactly like a file the picker returned. */
  savePastedImage: (bytes: Uint8Array, ext: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.savePastedImage, bytes, ext),
  /** Read a local image as a data: URL for inline preview. null if unreadable. */
  readImageDataUrl: (path: string, maxDimension?: number): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.readImageDataUrl, path, maxDimension),
  /** Project board (.chathub/board.json) — todos + agent notes. */
  boardRead: (cwd: string): Promise<Board> =>
    ipcRenderer.invoke(IpcChannels.boardRead, cwd),
  boardWrite: (cwd: string, board: Board): Promise<Board> =>
    ipcRenderer.invoke(IpcChannels.boardWrite, cwd, board),
  /** Project scripts (.chathub/scripts.json) — named commands for the top bar. */
  scriptsList: (cwd: string): Promise<ScriptsFile> =>
    ipcRenderer.invoke(IpcChannels.scriptsList, cwd),
  scriptsSave: (cwd: string, scripts: ProjectScript[]): Promise<ScriptsFile> =>
    ipcRenderer.invoke(IpcChannels.scriptsSave, cwd, scripts),
  listProjects: (): Promise<Project[]> =>
    ipcRenderer.invoke(IpcChannels.listProjects),
  addProject: (
    cwd?: string,
  ): Promise<{ project: Project; projects: Project[] } | null> =>
    ipcRenderer.invoke(IpcChannels.addProject, cwd),
  renameProject: (id: string, name: string): Promise<Project[]> =>
    ipcRenderer.invoke(IpcChannels.renameProject, id, name),
  removeProject: (id: string): Promise<Project[]> =>
    ipcRenderer.invoke(IpcChannels.removeProject, id),
  setGeneralConfig: (
    patch: GeneralConfig,
  ): Promise<{ general: GeneralConfig }> =>
    ipcRenderer.invoke(IpcChannels.setGeneralConfig, patch),
  getDataPaths: (): Promise<DataPaths> =>
    ipcRenderer.invoke(IpcChannels.getDataPaths),
  /** App version + build commit, for the Advanced tab and support threads. */
  getBuildInfo: (): Promise<BuildInfo> =>
    ipcRenderer.invoke(IpcChannels.getBuildInfo),
  /** Walks the data folder, so callers should treat it as slow. */
  getStorageStats: (): Promise<StorageStats> =>
    ipcRenderer.invoke(IpcChannels.getStorageStats),
  /** Merged daily usage ledger with today / 7d / 30d rollups. */
  usageSummary: (): Promise<UsageSummary> =>
    ipcRenderer.invoke(IpcChannels.usageSummary),
  revealPath: (target: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.revealPath, target),
  wipeSessions: (): Promise<SessionSnapshot> =>
    ipcRenderer.invoke(IpcChannels.wipeSessions),
  listPermissions: (): Promise<PermissionRequestInfo[]> =>
    ipcRenderer.invoke(IpcChannels.listPermissions),
  /** False when the island (or the CLI dying) already settled the request. */
  resolvePermission: (requestId: string, allow: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.resolvePermission, requestId, allow),
  resolveInput: (
    requestId: string,
    answers: Record<string, string[]>,
  ): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.resolveInput, requestId, answers),
  onHubEvent: (cb: (event: HubEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, event: HubEvent) => cb(event)
    ipcRenderer.on(IpcChannels.hubEvent, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.hubEvent, handler)
    }
  },
  /** Every listable file in the workspace, for the ⌘P picker. */
  projectFiles: (cwd: string): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.projectFiles, cwd),
  /** Case-insensitive fixed-string content search, for ⇧⌘F. */
  projectSearch: (cwd: string, query: string): Promise<ProjectSearchHit[]> =>
    ipcRenderer.invoke(IpcChannels.projectSearch, cwd, query),
  listDir: (cwd: string, relPath: string): Promise<DirListing> =>
    ipcRenderer.invoke(IpcChannels.listDir, cwd, relPath),
  readFileText: (cwd: string, relPath: string): Promise<FileContents> =>
    ipcRenderer.invoke(IpcChannels.readFile, cwd, relPath),
  /** One round trip that also decides how the file should be rendered. */
  openFile: (cwd: string, relPath: string): Promise<OpenedFile> =>
    ipcRenderer.invoke(IpcChannels.openFile, cwd, relPath),
  /** Rejects when the on-disk stamp no longer matches the one the read saw. */
  saveFile: (
    cwd: string,
    relPath: string,
    text: string,
    stamp: FileStamp,
  ): Promise<FileSaved> =>
    ipcRenderer.invoke(IpcChannels.saveFile, cwd, relPath, text, stamp),
  /** Creates an empty file, refusing when anything already sits at that path. */
  createFile: (cwd: string, relPath: string): Promise<FileSaved> =>
    ipcRenderer.invoke(IpcChannels.createFile, cwd, relPath),
  createDirectory: (cwd: string, relPath: string): Promise<DirEntry> =>
    ipcRenderer.invoke(IpcChannels.createDirectory, cwd, relPath),
  termStart: (
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<TerminalHandle> =>
    ipcRenderer.invoke(IpcChannels.termStart, cwd, cols, rows),
  termWrite: (ptyId: string, data: string): void => {
    ipcRenderer.send(IpcChannels.termWrite, ptyId, data)
  },
  termResize: (ptyId: string, cols: number, rows: number): void => {
    ipcRenderer.send(IpcChannels.termResize, ptyId, cols, rows)
  },
  termKill: (ptyId: string): void => {
    ipcRenderer.send(IpcChannels.termKill, ptyId)
  },
  onTerminalData: (cb: (chunk: TerminalChunk) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, chunk: TerminalChunk) => cb(chunk)
    ipcRenderer.on(IpcChannels.termData, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.termData, handler)
    }
  },
  onTerminalExit: (cb: (event: TerminalExit) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, event: TerminalExit) => cb(event)
    ipcRenderer.on(IpcChannels.termExit, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.termExit, handler)
    }
  },
  /**
   * Hands main the guest's WebContents id so an agent's MCP call can drive the
   * very webview the user is looking at, rather than a headless second browser.
   */
  browserAttach: (sessionId: string, webContentsId: number): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.browserAttach, sessionId, webContentsId),
  browserDetach: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.browserDetach, sessionId),
  onBrowserActivity: (cb: (event: BrowserActivity) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, event: BrowserActivity) => cb(event)
    ipcRenderer.on(IpcChannels.browserActivity, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.browserActivity, handler)
    }
  },
  /** Main asking for the panel, because an agent called a browser tool. */
  onBrowserOpen: (cb: (sessionId: string) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, sessionId: string) => cb(sessionId)
    ipcRenderer.on(IpcChannels.browserOpen, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.browserOpen, handler)
    }
  },
  /** An agent's dock tool asking for a surface; the renderer decides what shows. */
  onSurfaceOpen: (cb: (request: SurfaceOpenRequest) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, request: SurfaceOpenRequest) =>
      cb(request)
    ipcRenderer.on(IpcChannels.surfaceOpen, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.surfaceOpen, handler)
    }
  },
  onHubLayout: (cb: (command: HubLayoutCommand) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, command: HubLayoutCommand) =>
      cb(command)
    ipcRenderer.on(IpcChannels.hubLayout, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.hubLayout, handler)
    }
  },
  /** Mirror the dock's visible state into main, so a tool can report it. */
  reportSurfaceState: (state: SurfaceStateReport): void => {
    ipcRenderer.send(IpcChannels.surfaceState, state)
  },
  reportAttentionCount: (count: number): void => {
    ipcRenderer.send(IpcChannels.attentionCount, count)
  },
  reportWindowSessions: (
    sessionIds: string[],
    attachedIds?: string[],
  ): void => {
    ipcRenderer.send(
      IpcChannels.windowSessions,
      sessionIds,
      attachedIds ?? sessionIds,
    )
  },
  openWindow: (sessionId?: string): Promise<number> =>
    ipcRenderer.invoke(IpcChannels.windowOpen, sessionId ?? null),
  mcpList: (cwd: string): Promise<McpListResult> =>
    ipcRenderer.invoke(IpcChannels.mcpList, cwd),
  mcpUpsert: (cwd: string, server: McpServerDef): Promise<McpListResult> =>
    ipcRenderer.invoke(IpcChannels.mcpUpsert, cwd, server),
  mcpRemove: (cwd: string, id: string): Promise<McpListResult> =>
    ipcRenderer.invoke(IpcChannels.mcpRemove, cwd, id),
  mcpSetEnabled: (
    cwd: string,
    id: string,
    enabled: boolean,
  ): Promise<McpListResult> =>
    ipcRenderer.invoke(IpcChannels.mcpSetEnabled, cwd, id, enabled),
  mcpSetEnv: (
    serverId: string,
    envPatch: Record<string, string>,
  ): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.mcpSetEnv, serverId, envPatch),
  mcpMaterialize: (cwd: string): Promise<McpMaterializeResult> =>
    ipcRenderer.invoke(IpcChannels.mcpMaterialize, cwd),
  mcpStatus: (cwd: string): Promise<McpServerStatus[]> =>
    ipcRenderer.invoke(IpcChannels.mcpStatus, cwd),
  /** Append `.mcp.json` / `opencode.json` to project `.gitignore` (user-initiated). */
  mcpAddGitignore: (
    cwd: string,
    paths: string[],
  ): Promise<McpGitignoreResult> =>
    ipcRenderer.invoke(IpcChannels.mcpAddGitignore, cwd, paths),
  grokTrustStatus: (cwd: string): Promise<{ trusted: boolean; path: string }> =>
    ipcRenderer.invoke(IpcChannels.grokTrustStatus, cwd),
  grokTrustFolder: (cwd: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.grokTrustFolder, cwd),
  /** True when Handy (the local dictation app) is installed on this machine. */
  voiceAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.voiceAvailable),
  /**
   * Start/stop Handy dictation; false when Handy is missing or refused. The
   * intent keeps a "stop" from relaunching a dead Handy into a fresh take.
   */
  voiceToggle: (intent: "start" | "stop"): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.voiceToggle, intent),
  voiceCancel: (): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.voiceCancel),
  /** Project context (.chathub/context/*.md) — overview, stack, conventions, focus. */
  contextRead: (cwd: string): Promise<ProjectContext> =>
    ipcRenderer.invoke(IpcChannels.contextRead, cwd),
  contextWriteDoc: (
    cwd: string,
    id: ContextDocId,
    text: string,
  ): Promise<ProjectContext> =>
    ipcRenderer.invoke(IpcChannels.contextWriteDoc, cwd, id, text),
  /** No id = create what is missing; an id = re-detect that one document. */
  contextSeed: (cwd: string, id?: ContextDocId): Promise<ProjectContext> =>
    ipcRenderer.invoke(IpcChannels.contextSeed, cwd, id ?? null),
  contextSetShare: (cwd: string, share: boolean): Promise<ProjectContext> =>
    ipcRenderer.invoke(IpcChannels.contextSetShare, cwd, share),
}

contextBridge.exposeInMainWorld("chatHub", api)

export type ChatHubApi = typeof api
