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
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]
