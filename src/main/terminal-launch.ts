import { spawn } from "node:child_process"
import { platform } from "node:os"

/** Open macOS Terminal.app running a login/setup command. */
export function openLoginTerminal(command: string): void {
  if (platform() === "darwin") {
    const script = `
      tell application "Terminal"
        activate
        do script ${JSON.stringify(command)}
      end tell
    `
    spawn("osascript", ["-e", script], {
      detached: true,
      stdio: "ignore",
    }).unref()
    return
  }
  // Fallback: best-effort shell
  spawn("sh", ["-c", command], {
    detached: true,
    stdio: "ignore",
  }).unref()
}
