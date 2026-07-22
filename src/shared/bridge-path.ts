import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Shared SessionEvent JSONL path (Chat Hub producer, Session Monitor consumer).
 * macOS: ~/Library/Application Support/agent-desktop/events.jsonl
 */
function agentDesktopDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "agent-desktop")
  }
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    return join(base, "agent-desktop")
  }
  return join(homedir(), ".local", "share", "agent-desktop")
}

export function agentDesktopEventsPath(): string {
  if (process.env.AGENT_DESKTOP_EVENTS) {
    return process.env.AGENT_DESKTOP_EVENTS
  }
  return join(agentDesktopDir(), "events.jsonl")
}

/** Session Monitor → Chat Hub reverse channel. */
export function agentDesktopCommandsPath(): string {
  if (process.env.AGENT_DESKTOP_COMMANDS) {
    return process.env.AGENT_DESKTOP_COMMANDS
  }
  return join(agentDesktopDir(), "commands.jsonl")
}
