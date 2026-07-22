import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import { IpcChannels } from "@shared/ipc"
import type {
  CreateSessionInput,
  GitCheckoutInfo,
  HubEvent,
  ProviderInfo,
  SessionMeta,
  SessionSnapshot,
  ChatMessage,
} from "@shared/types"

const api = {
  getSnapshot: (): Promise<SessionSnapshot> =>
    ipcRenderer.invoke(IpcChannels.getSnapshot),
  listSessions: (): Promise<SessionMeta[]> =>
    ipcRenderer.invoke(IpcChannels.listSessions),
  getMessages: (sessionId: string): Promise<ChatMessage[]> =>
    ipcRenderer.invoke(IpcChannels.getMessages, sessionId),
  createSession: (input: CreateSessionInput): Promise<SessionMeta> =>
    ipcRenderer.invoke(IpcChannels.createSession, input),
  sendMessage: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.sendMessage, sessionId, text),
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
