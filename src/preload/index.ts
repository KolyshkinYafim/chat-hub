import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import { IpcChannels } from "@shared/ipc"
import type {
  CreateSessionInput,
  GitCheckoutInfo,
  HubEvent,
  ProviderId,
  ProviderInfo,
  SessionMeta,
  SessionSnapshot,
  ChatMessage,
} from "@shared/types"
import type { PermissionMode } from "@shared/permission"
import type {
  ProviderConfig,
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
    id: ProviderId,
  ): Promise<{ ok: boolean; command: string }> =>
    ipcRenderer.invoke(IpcChannels.providerLogin, id),
  setSessionModel: (sessionId: string, model: string): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.setSessionModel, sessionId, model),
  setSessionTitle: (sessionId: string, title: string): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.setSessionTitle, sessionId, title),
  pickFiles: (): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.pickFiles),
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
