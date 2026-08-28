import type { SessionStatus } from "@shared/types"

export function formatRelative(ts: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000))
  if (sec < 45) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 48) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 14) return `${day}d ago`
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })
}

export const statusLabel: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Working",
  waiting_input: "Waiting",
  error: "Error",
  done: "Done",
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function shortCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean)
  if (parts.length <= 2) return cwd
  return parts.slice(-2).join("/")
}
