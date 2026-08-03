import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"

export type RunSpec = {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  /** ENOENT/EACCES etc. — never reaches stderr, so callers must be told. */
  onSpawnError?: (err: Error) => void
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

export type RunningProcess = {
  pid: number | undefined
  abort: () => void
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/**
 * Spawn a CLI with line-oriented stdout/stderr and kill-tree abort.
 * Never leaves zombie UI state: callers must map exit → session status.
 */
export function runProcess(spec: RunSpec): RunningProcess {
  const child: ChildProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: {
      ...process.env,
      ...spec.env,
      // Prefer machine-readable output from tools
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
    },
    stdio: ["ignore", "pipe", "pipe"],
    // detached helps kill group on macOS/linux
    detached: process.platform !== "win32",
  })

  let settled = false
  let resolveDone!: (v: {
    code: number | null
    signal: NodeJS.Signals | null
  }) => void
  const done = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve) => {
    resolveDone = resolve
  })

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return
    settled = true
    resolveDone({ code, signal })
    try {
      spec.onExit?.(code, signal)
    } catch (err) {
      console.error("[process-runner] onExit error", err)
    }
  }

  if (spec.onStdoutLine && child.stdout) {
    const rl = createInterface({ input: child.stdout })
    rl.on("line", (line) => {
      try {
        spec.onStdoutLine?.(line)
      } catch (err) {
        console.error("[process-runner] stdout handler", err)
      }
    })
  } else {
    child.stdout?.resume()
  }

  if (spec.onStderrLine && child.stderr) {
    const rl = createInterface({ input: child.stderr })
    rl.on("line", (line) => {
      try {
        spec.onStderrLine?.(line)
      } catch (err) {
        console.error("[process-runner] stderr handler", err)
      }
    })
  } else {
    child.stderr?.resume()
  }

  child.on("error", (err) => {
    console.error("[process-runner] spawn error", err)
    try {
      spec.onSpawnError?.(err)
    } catch (e) {
      console.error("[process-runner] onSpawnError handler", e)
    }
    finish(1, null)
  })

  child.on("close", (code, signal) => {
    finish(code, signal)
  })

  const abort = () => {
    if (settled) return
    try {
      if (child.pid && process.platform !== "win32") {
        // Kill the process group started with detached
        process.kill(-child.pid, "SIGTERM")
        setTimeout(() => {
          try {
            if (!settled && child.pid) process.kill(-child.pid, "SIGKILL")
          } catch {
            /* already dead */
          }
        }, 1500)
      } else {
        child.kill("SIGTERM")
        setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {
            /* */
          }
        }, 1500)
      }
    } catch {
      try {
        child.kill("SIGKILL")
      } catch {
        /* */
      }
    }
  }

  return { pid: child.pid, abort, done }
}
