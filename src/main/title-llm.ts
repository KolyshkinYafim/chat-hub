import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { join } from "node:path"
import { findBinary } from "./adapters/binary"
import { sanitizeLlmTitle } from "@shared/title"

const HOME = homedir()

const CLAUDE_NAMES = [
  "claude",
  join(HOME, ".claude", "local", "claude"),
  join(HOME, ".local", "bin", "claude"),
]

export const TITLE_TIMEOUT_MS = 20_000

const USER_EXCERPT_CHARS = 600
const ASSISTANT_EXCERPT_CHARS = 400

export type TitleRunner = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>

const execFileAsync = promisify(execFile)

const realRunner: TitleRunner = async (bin, args, timeoutMs) => {
  const child = execFileAsync(bin, args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  })
  // The CLI reads a piped stdin and stalls waiting for it (see provider-probe).
  child.child.stdin?.end()
  const { stdout } = await child
  return String(stdout ?? "")
}

export function resolveClaudeBinary(): string | null {
  return findBinary(CLAUDE_NAMES)
}

export function buildTitlePrompt(
  userMessage: string,
  assistantExcerpt: string,
): string {
  const user = userMessage.slice(0, USER_EXCERPT_CHARS)
  const assistant = assistantExcerpt.slice(0, ASSISTANT_EXCERPT_CHARS)
  return [
    "Name this coding chat session. Reply with the title only:",
    "3-6 words, no quotes, no trailing punctuation, no prefix like \"Title:\",",
    "in the same language the user wrote in (Russian message → Russian title).",
    "",
    "User message:",
    user,
    ...(assistant ? ["", "Assistant reply (excerpt):", assistant] : []),
  ].join("\n")
}

export function buildTitleArgs(prompt: string): string[] {
  return ["-p", "--model", "haiku", "--output-format", "json", prompt]
}

/** The CLI's --output-format json answers one JSON object with a `result` string. */
export function parseTitleOutput(raw: string): string | null {
  for (const line of raw.split("\n")) {
    const text = line.trim()
    if (!text.startsWith("{")) continue
    try {
      const parsed = JSON.parse(text) as { result?: unknown }
      if (typeof parsed.result === "string" && parsed.result.trim()) {
        return parsed.result
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Best-effort one-shot title from the claude CLI. Every failure — no binary,
 * timeout, non-JSON output, rambling answer — collapses to null so the caller
 * keeps whatever title it already has.
 */
export async function generateTitle(
  userMessage: string,
  assistantExcerpt: string,
  deps: { run?: TitleRunner; binary?: string | null } = {},
): Promise<string | null> {
  const bin = deps.binary !== undefined ? deps.binary : resolveClaudeBinary()
  if (!bin) return null
  const run = deps.run ?? realRunner
  try {
    const raw = await run(
      bin,
      buildTitleArgs(buildTitlePrompt(userMessage, assistantExcerpt)),
      TITLE_TIMEOUT_MS,
    )
    const result = parseTitleOutput(raw)
    return result ? sanitizeLlmTitle(result) : null
  } catch {
    return null
  }
}
