export const IpcChannels = {
  createSession: "session:create",
  listSessions: "session:list",
  getMessages: "session:messages",
  sendMessage: "session:send",
  abortSession: "session:abort",
  deleteSession: "session:delete",
  setActiveSession: "session:set-active",
  getSnapshot: "session:snapshot",
  listProviders: "providers:list",
  getBridgePath: "bridge:path",
  hubEvent: "hub:event",
  pickFolder: "dialog:pick-folder",
  openPath: "shell:open-path",
  openInEditor: "shell:open-editor",
  getGitInfo: "git:info",
  gitCommit: "git:commit",
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
