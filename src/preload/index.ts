import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import { IpcChannels } from "@shared/ipc"
import type {
  CreateSessionInput,
  GitBranchList,
  GitCheckoutInfo,
  GitWorkingCopy,
  HubEvent,
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
  DataPaths,
  GeneralConfig,
  ProviderConfig,
  ProviderInstance,
  ProviderStatus,
  SettingsSnapshot,
} from "@shared/settings-types"

const api = {
  getSnapshot: (): Promise<SessionSnapshot> =>
    ipcRenderer.invoke(IpcChannels.getSnapshot),
  listSessions: (): Promise<SessionMeta[]> =>
    ipcRenderer.invoke(IpcChannels.listSessions),
  getMessages: (sessionId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke(IpcChannels.getMessages, sessionId),
  createSession: (input: CreateSessionInput): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.createSession, input),
  sendMessage: (
    sessionId: string,
    text: string,
    opts?: { effort?: "low" | "medium" | "high" | "max"; attachments?: string[] },
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
  /** Persist a pasted/dropped image blob to disk; returns its absolute path so
   *  the composer can attach it exactly like a file the picker returned. */
  savePastedImage: (bytes: Uint8Array, ext: string): Promise<string> =>
    ipcRenderer.invoke(IpcChannels.savePastedImage, bytes, ext),
  /** Read a local image as a data: URL for inline preview. null if unreadable. */
  readImageDataUrl: (path: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.readImageDataUrl, path),
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
  onHubEvent: (cb: (event: HubEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, event: HubEvent) => cb(event)
    ipcRenderer.on(IpcChannels.hubEvent, handler)
    return () => {
      ipcRenderer.removeListener(IpcChannels.hubEvent, handler)
    }
  },
}

contextBridge.exposeInMainWorld("chatHub", api)

export type ChatHubApi = typeof api
