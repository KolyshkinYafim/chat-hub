import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Shared SessionEvent JSONL path (Chat Hub producer, Session Monitor consumer).
 * macOS: ~/Library/Application Support/agent-desktop/events.jsonl
 */
export function agentDesktopEventsPath(): string {
  if (process.env.AGENT_DESKTOP_EVENTS) {
    return process.env.AGENT_DESKTOP_EVENTS
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "agent-desktop",
      "events.jsonl",
    )
  }
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    return join(base, "agent-desktop", "events.jsonl")
  }
  return join(homedir(), ".local", "share", "agent-desktop", "events.jsonl")
}
