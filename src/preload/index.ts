import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron"
import { IpcChannels } from "@shared/ipc"
import type {
  CreateSessionInput,
  GitBranchList,
  GitCheckoutInfo,
  GitWorkingCopy,
  GitWorktreeInfo,
  HubEvent,
  MessageAttachment,
  PermissionRequestInfo,
  Project,
  ProviderId,
  ProviderInfo,
  QueuedMessage,
  SessionMeta,
  SessionSnapshot,
  ChatMessage,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import type {
  Board,
  DirListing,
  FileContents,
  TerminalChunk,
  TerminalExit,
  TerminalHandle,
} from "@shared/surfaces"
import type {
  DataPaths,
  GeneralConfig,
  ProviderConfig,
  ProviderInstance,
  ProviderStatus,
  SettingsSnapshot,
} from "@shared/settings-types"
import type {
  McpGitignoreResult,
  McpListResult,
  McpMaterializeResult,
  McpServerDef,
  McpServerStatus,
} from "@shared/mcp"

const api = {
  getSnapshot: (): Promise<SessionSnapshot> =>
    ipcRenderer.invoke(IpcChannels.getSnapshot),
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
  gitBranches: (cwd: string): Promise<GitBranchList> =>
    ipcRenderer.invoke(IpcChannels.gitBranches, cwd),
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
  gitWorktrees: (cwd: string): Promise<GitWorktreeInfo[]> =>
    ipcRenderer.invoke(IpcChannels.gitWorktrees, cwd),
  gitRemoveWorktree: (
    repoCwd: string,
    worktreePath: string,
  ): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitRemoveWorktree, repoCwd, worktreePath),
  gitPruneWorktrees: (repoCwd: string): Promise<{ ok: boolean; output: string }> =>
    ipcRenderer.invoke(IpcChannels.gitPruneWorktrees, repoCwd),
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
  setSessionTitle: (sessionId: string, title: string): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.setSessionTitle, sessionId, title),
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
  listDir: (cwd: string, relPath: string): Promise<DirListing> =>
    ipcRenderer.invoke(IpcChannels.listDir, cwd, relPath),
  readFileText: (cwd: string, relPath: string): Promise<FileContents> =>
    ipcRenderer.invoke(IpcChannels.readFile, cwd, relPath),
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
}

contextBridge.exposeInMainWorld("chatHub", api)

export type ChatHubApi = typeof api
