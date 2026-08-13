import { homedir } from "node:os"
import { join } from "node:path"
import { BROWSER_SOCKET_BASENAME, BROWSER_SOCKET_ENV } from "./browser"

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

/**
 * Session Monitor's blocking permission socket. The Hub connects to it as a
 * client to mirror a request onto the island (session-monitor/docs/bridge.md).
 */
export function agentDesktopSocketPath(): string {
  if (process.env.AGENT_DESKTOP_SOCKET) {
    return process.env.AGENT_DESKTOP_SOCKET
  }
  return join(agentDesktopDir(), "monitor.sock")
}

/**
 * The Hub's own permission socket, same protocol. Hub-spawned CLIs get this
 * path as their AGENT_DESKTOP_SOCKET so their hook asks the Hub first — the Hub
 * then forwards to the island, so one tool call still reaches both windows.
 */
export function chatHubSocketPath(): string {
  if (process.env.CHAT_HUB_SOCKET) {
    return process.env.CHAT_HUB_SOCKET
  }
  return join(agentDesktopDir(), "hub.sock")
}

/** Where the built-in browser MCP server reaches the Hub's Browser surface. */
export function chatHubBrowserSocketPath(): string {
  if (process.env[BROWSER_SOCKET_ENV]) {
    return process.env[BROWSER_SOCKET_ENV]
  }
  return join(agentDesktopDir(), BROWSER_SOCKET_BASENAME)
}

/** Session Monitor → Chat Hub reverse channel. */
export function agentDesktopCommandsPath(): string {
  if (process.env.AGENT_DESKTOP_COMMANDS) {
    return process.env.AGENT_DESKTOP_COMMANDS
  }
  return join(agentDesktopDir(), "commands.jsonl")
}
