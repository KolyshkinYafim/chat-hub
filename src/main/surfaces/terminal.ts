import { accessSync, chmodSync, constants, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join } from "node:path"
import { randomUUID } from "node:crypto"
import type { IPty, IPtyForkOptions } from "node-pty"
import type {
  TerminalChunk,
  TerminalExit,
  TerminalHandle,
} from "@shared/surfaces"
import { resolveWorkspaceRoot } from "./paths"

export type TerminalSink = {
  data(chunk: TerminalChunk): void
  exit(event: TerminalExit): void
}

type PtyModule = {
  spawn(file: string, args: string[], options: IPtyForkOptions): IPty
}

const MIN_DIMENSION = 1
const MAX_DIMENSION = 1000
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MAX_LIVE_TERMINALS = 12
const MAX_WRITE_CHARS = 1024 * 1024
const UNIX_SHELL_CANDIDATES = ["/bin/zsh", "/bin/bash", "/bin/sh"]
const SPAWN_HELPER_MODE = 0o755

const requireFromMain = createRequire(import.meta.url)

let cachedPtyModule: PtyModule | null = null

function hasSpawn(value: unknown): value is PtyModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { spawn?: unknown }).spawn === "function"
  )
}

function asPtyModule(loaded: unknown): PtyModule {
  if (hasSpawn(loaded)) return loaded
  const fallback =
    typeof loaded === "object" && loaded !== null
      ? (loaded as { default?: unknown }).default
      : undefined
  if (hasSpawn(fallback)) return fallback
  throw new Error("node-pty did not expose spawn()")
}

function unpackedPath(path: string): string {
  return path
    .replace("app.asar", "app.asar.unpacked")
    .replace("node_modules.asar", "node_modules.asar.unpacked")
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isExecutableFile(path: string): boolean {
  return isFile(path) && isExecutable(path)
}

function spawnHelperCandidates(packageRoot: string): string[] {
  return [
    join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`),
    join(packageRoot, "build", "Release"),
    join(packageRoot, "build", "Debug"),
  ].map((dir) => unpackedPath(join(dir, "spawn-helper")))
}

function makeSpawnHelperExecutable(): void {
  if (process.platform === "win32") return
  let packageRoot: string
  try {
    packageRoot = dirname(dirname(requireFromMain.resolve("node-pty")))
  } catch {
    return
  }
  for (const helper of spawnHelperCandidates(packageRoot)) {
    if (!isFile(helper) || isExecutable(helper)) continue
    try {
      chmodSync(helper, SPAWN_HELPER_MODE)
    } catch (err) {
      console.warn("[surfaces] could not make spawn-helper executable", err)
    }
  }
}

function loadPty(): PtyModule {
  if (cachedPtyModule) return cachedPtyModule
  makeSpawnHelperExecutable()
  cachedPtyModule = asPtyModule(requireFromMain("node-pty"))
  return cachedPtyModule
}

export function normalizeDimension(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const whole = Math.floor(value)
  if (whole < MIN_DIMENSION) return MIN_DIMENSION
  if (whole > MAX_DIMENSION) return MAX_DIMENSION
  return whole
}

export function resolveLoginShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe"
  }
  const configured = process.env.SHELL
  if (configured && isAbsolute(configured) && isExecutableFile(configured)) {
    return configured
  }
  return UNIX_SHELL_CANDIDATES.find(isExecutableFile) ?? "/bin/sh"
}

function shellArgs(shell: string): string[] {
  return shell.endsWith("cmd.exe") || shell.endsWith("powershell.exe")
    ? []
    : ["-l"]
}

export function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value
  }
  delete env.ELECTRON_RUN_AS_NODE
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  return env
}

export class TerminalSessions {
  private readonly live = new Map<string, IPty>()

  constructor(private readonly sink: TerminalSink) {}

  get size(): number {
    return this.live.size
  }

  async start(
    cwd: unknown,
    cols: unknown,
    rows: unknown,
  ): Promise<TerminalHandle> {
    const root = resolveWorkspaceRoot(cwd)
    if (this.live.size >= MAX_LIVE_TERMINALS) {
      throw new Error("Too many open terminals")
    }
    const pty = loadPty()
    const shell = resolveLoginShell()
    const ptyId = randomUUID()
    const child = pty.spawn(shell, shellArgs(shell), {
      name: "xterm-256color",
      cwd: root,
      env: terminalEnv(),
      cols: normalizeDimension(cols, DEFAULT_COLS),
      rows: normalizeDimension(rows, DEFAULT_ROWS),
    })

    this.live.set(ptyId, child)
    child.onData((data) => {
      this.sink.data({ ptyId, data })
    })
    child.onExit(({ exitCode }) => {
      this.live.delete(ptyId)
      this.sink.exit({ ptyId, exitCode })
    })
    return { ptyId }
  }

  write(ptyId: unknown, data: unknown): boolean {
    const child = this.lookup(ptyId)
    if (!child) return false
    if (typeof data !== "string" || data.length === 0) return false
    child.write(data.slice(0, MAX_WRITE_CHARS))
    return true
  }

  resize(ptyId: unknown, cols: unknown, rows: unknown): boolean {
    const child = this.lookup(ptyId)
    if (!child) return false
    child.resize(
      normalizeDimension(cols, DEFAULT_COLS),
      normalizeDimension(rows, DEFAULT_ROWS),
    )
    return true
  }

  kill(ptyId: unknown): boolean {
    if (typeof ptyId !== "string") return false
    const child = this.live.get(ptyId)
    if (!child) return false
    this.live.delete(ptyId)
    try {
      child.kill()
    } catch (err) {
      console.warn("[surfaces] pty kill failed", err)
      return false
    }
    return true
  }

  killAll(): void {
    for (const child of this.live.values()) {
      try {
        child.kill()
      } catch (err) {
        console.warn("[surfaces] pty kill on quit failed", err)
      }
    }
    this.live.clear()
  }

  private lookup(ptyId: unknown): IPty | undefined {
    if (typeof ptyId !== "string" || !ptyId) return undefined
    return this.live.get(ptyId)
  }
}
