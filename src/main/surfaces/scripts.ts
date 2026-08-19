import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  SCRIPTS_REL_PATH,
  emptyScriptsFile,
  parseScriptsFile,
  type ScriptsFile,
} from "@shared/scripts"
import { writeFileAtomic } from "../atomic-write"
import { isEnoent } from "../fs-util"
import { resolveWorkspaceRoot } from "./paths"

const execFileAsync = promisify(execFile)

const SETUP_TIMEOUT_MS = 5 * 60_000
const SETUP_MAX_BUFFER = 8 * 1024 * 1024
const FAILURE_DETAIL_CHARS = 400

function scriptsPath(cwd: unknown): string {
  return join(resolveWorkspaceRoot(cwd), SCRIPTS_REL_PATH)
}

export async function readScripts(cwd: unknown): Promise<ScriptsFile> {
  let text: string
  try {
    text = await readFile(scriptsPath(cwd), "utf8")
  } catch (e) {
    if (isEnoent(e)) return emptyScriptsFile()
    throw e
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return emptyScriptsFile()
  }
  return parseScriptsFile(raw)
}

/** Whole-file save, last write wins; `updatedAt` is stamped here. */
export async function writeScripts(cwd: unknown, scripts: unknown): Promise<ScriptsFile> {
  const next = parseScriptsFile({ scripts })
  next.updatedAt = Date.now()
  await writeFileAtomic(scriptsPath(cwd), JSON.stringify(next, null, 2))
  return next
}

export type ScriptExecResult = { ok: boolean; detail: string }

export type ScriptExec = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<ScriptExecResult>

function setupShell(): { file: string; args: (command: string) => string[] } {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: (command) => ["/d", "/s", "/c", command],
    }
  }
  const configured = process.env.SHELL
  return {
    file: configured && isAbsolute(configured) ? configured : "/bin/sh",
    args: (command) => ["-lc", command],
  }
}

function failureDetail(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string } | null
  const text = (e?.stderr || e?.stdout || e?.message || String(err)).trim()
  const lastLine = text.split("\n").filter((line) => line.trim() !== "").pop()
  return (lastLine ?? "failed").slice(0, FAILURE_DETAIL_CHARS)
}

const shellExec: ScriptExec = async (command, cwd, timeoutMs) => {
  const shell = setupShell()
  try {
    await execFileAsync(shell.file, shell.args(command), {
      cwd,
      timeout: timeoutMs,
      maxBuffer: SETUP_MAX_BUFFER,
    })
    return { ok: true, detail: "" }
  } catch (err) {
    return { ok: false, detail: failureDetail(err) }
  }
}

/**
 * Run the base project's `runOnWorktreeCreate` scripts sequentially in a fresh
 * worktree. Never throws: every outcome (including a script failure) comes back
 * as a transcript-ready notice line, so a broken setup script can only annotate
 * session creation, not fail it.
 */
export async function runWorktreeCreateScripts(
  baseCwd: string,
  worktreeCwd: string,
  exec: ScriptExec = shellExec,
): Promise<string[]> {
  let file: ScriptsFile
  try {
    file = await readScripts(baseCwd)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return [`Worktree setup skipped — scripts.json could not be read (${detail}).`]
  }
  const setup = file.scripts.filter((script) => script.runOnWorktreeCreate)
  const notes: string[] = []
  for (const script of setup) {
    const result = await exec(script.command, worktreeCwd, SETUP_TIMEOUT_MS).catch(
      (err: unknown): ScriptExecResult => ({ ok: false, detail: failureDetail(err) }),
    )
    notes.push(
      result.ok
        ? `Worktree setup — "${script.name}" (${script.command}) finished.`
        : `Worktree setup — "${script.name}" (${script.command}) failed: ${result.detail}. The session is still usable.`,
    )
  }
  return notes
}
