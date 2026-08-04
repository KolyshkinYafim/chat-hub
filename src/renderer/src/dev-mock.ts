/**
 * Dev-only mock of the preload `window.chatHub` bridge so the real React UI
 * can be rendered (and screenshotted) in a plain browser tab without Electron.
 * Activated only with `?mock=1` in dev — never ships in the Electron app.
 */
import type {
  ChatMessage,
  MessageAttachment,
  PermissionRequestInfo,
  Project,
  QueuedMessage,
  SessionMeta,
  SessionSnapshot,
  SessionUsage,
} from "@shared/types"
import type {
  ProviderInstance,
  ProviderStatus,
  SettingsSnapshot,
} from "@shared/settings-types"
import type { McpServerDef } from "@shared/mcp"
import { encodeToolCardMeta, type ToolCardMeta } from "@shared/tool-card"
import {
  BINARY_TYPE,
  TEXT_TYPE,
  fileTypeByExtension,
  type FileType,
} from "@shared/file-kind"
import { STALE_WRITE_MESSAGE } from "@shared/surfaces"
import type {
  Board,
  FileStamp,
  OpenedFile,
  SurfaceBridge,
  TerminalChunk,
  TerminalExit,
} from "./lib/surface-bridge"

type ChatHubApi = Window["chatHub"]

const now = Date.UTC(2026, 6, 22, 15, 40)

// The transcript is a markdown string, exactly as the adapters emit it — the
// mock has to speak that format or it proves nothing about the real renderer.
function call(name: string, head: string, meta: ToolCardMeta = {}): string {
  return `\n\n\`\`\`tool:${name}\n${encodeToolCardMeta(meta)}${head}\n\`\`\`\n\n`
}

function result(name: string, body: string, meta: ToolCardMeta = {}): string {
  return `\n\n\`\`\`tool-result:${name}\n${encodeToolCardMeta(meta)}${body}\n\`\`\`\n\n`
}

// Body lines are `marker + space + text`, hunks introduced by an @@ header —
// the same unified shape buildEditDiff emits from an Edit/Write payload.
function diff(lines: string[]): string {
  return `\`\`\`diff\n${lines.join("\n")}\n\`\`\`\n\n`
}

const jwtDiff = [
  "@@ -12,7 +12,8 @@",
  "  export function verifyJwt(token: string): Claims | null {",
  "    const claims = decode(token)",
  "    if (!claims) return null",
  "-   if (claims.iat < Date.now() / 1000) return null",
  "+   const nowSeconds = Math.floor(Date.now() / 1000)",
  "+   if (claims.exp <= nowSeconds) return null",
  "    return claims",
  "  }",
  "@@ -31,4 +32,4 @@",
  "  export function isExpired(claims: Claims): boolean {",
  "-   return claims.iat < Date.now() / 1000",
  "+   return claims.exp <= Math.floor(Date.now() / 1000)",
  "  }",
]

const clockDiff = [
  "@@ -0,0 +1,9 @@",
  "+ /** Seconds since the epoch, the unit every JWT claim is written in. */",
  '+ export function nowSeconds(): number {',
  "+   return Math.floor(Date.now() / 1000)",
  "+ }",
  "+ ",
  "+ export function isPast(at: number): boolean {",
  "+   return at <= nowSeconds()",
  "+ }",
  "+ ",
]

const authDiff = [
  "@@ -1,4 +1,5 @@",
  "  import { Router } from 'express'",
  "  import { verifyJwt } from '../lib/jwt'",
  "+ import { isPast } from '../lib/clock'",
  "  ",
  "  export function requireAuth(req, res, next) {",
  "@@ -9,7 +10,5 @@",
  "    const token = req.headers.authorization?.slice(7)",
  "    if (!token) return res.status(401).end()",
  "    const decoded = verifyJwt(token)",
  "-   if (!decoded) return res.status(401).end()",
  "-   if (decoded.iat < Date.now() / 1000) return res.status(401).end()",
  "+   if (!decoded || isPast(decoded.exp)) return res.status(401).end()",
  "    req.user = decoded",
  "    next()",
]

const suitePass = [
  "> proxy-flash-admin@0.1.0 test",
  "> vitest run --reporter verbose",
  "",
  " RUN  v3.2.7 /Users/lic/ProxyFlash/proxy-flash-admin",
  "",
  " ✓ tests/auth.test.ts (4 tests) 21ms",
  "   ✓ verifyJwt > rejects an expired token",
  "   ✓ verifyJwt > rejects a malformed token",
  "   ✓ verifyJwt > accepts a valid token",
  "   ✓ requireAuth > passes the decoded user downstream",
  " ✓ tests/routes.test.ts (6 tests) 44ms",
  " ✓ tests/webhooks.test.ts (9 tests) 91ms",
  " ✓ tests/reward.test.ts (3 tests) 12ms",
  " ✓ tests/settings.test.ts (11 tests) 63ms",
  "",
  " Test Files  5 passed (5)",
  "      Tests  33 passed (33)",
  "   Start at  15:38:04",
  "   Duration  1.62s",
].join("\n")

const suiteFail = [
  " FAIL  tests/expiry.test.ts > expiry > rejects a token past its exp",
  "AssertionError: expected null to be an object",
  "",
  "- Expected",
  "+ Received",
  "",
  "- { sub: 'u_31', exp: 1750000000 }",
  "+ null",
  "",
  " ❯ tests/expiry.test.ts:18:24",
  "    16|   it('rejects a token past its exp', () => {",
  "    17|     const claims = verifyJwt(expired)",
  "    18|     expect(claims).toBeNull()",
  "      |                    ^",
  "",
  " Test Files  1 failed (1)",
  "      Tests  1 failed (1)",
].join("\n")

// One turn that has to answer all three questions at a glance: several Bash
// calls, one of them failing, an Edit with its diff, and output long enough
// that showing it whole would bury the reply.
const busyTurn =
  "The expiry test is red — I'll reproduce it, read the middleware and fix the claim it checks.\n\n" +
  call("Bash", "$ pnpm test", {
    id: "t1",
    desc: "Run the whole suite",
  }) +
  result("Bash", suitePass, { id: "t1", exitCode: 0 }) +
  call("Bash", "$ pnpm test -- expiry", {
    id: "t2",
    desc: "Reproduce the expiry failure",
  }) +
  result("Bash", suiteFail, { id: "t2", exitCode: 1, error: true }) +
  call("Read", "/Users/lic/ProxyFlash/proxy-flash-admin/src/lib/jwt.ts", {
    id: "t3",
  }) +
  result(
    "Read",
    [
      "export function verifyJwt(token: string) {",
      "  const claims = decode(token)",
      "  if (!claims) return null",
      "  if (claims.iat < Date.now() / 1000) return null",
      "  return claims",
      "}",
    ].join("\n"),
    { id: "t3" },
  ) +
  "\nThere it is: the guard compares `iat` (issued-at) instead of `exp`, so every token looks expired the moment it is issued. Three files need touching — the check itself, a small clock helper, and the middleware that duplicates the guard.\n\n" +
  call("Edit", "/Users/lic/ProxyFlash/proxy-flash-admin/src/lib/jwt.ts", {
    id: "t4",
    desc: "Compare exp, not iat",
    paths: ["/Users/lic/ProxyFlash/proxy-flash-admin/src/lib/jwt.ts"],
    added: 3,
    removed: 2,
    absLines: true,
  }) +
  diff(jwtDiff) +
  result("Edit", "The file has been updated.", { id: "t4" }) +
  call("Write", "/Users/lic/ProxyFlash/proxy-flash-admin/src/lib/clock.ts", {
    id: "t5",
    paths: ["/Users/lic/ProxyFlash/proxy-flash-admin/src/lib/clock.ts"],
    added: 9,
    removed: 0,
    absLines: true,
  }) +
  diff(clockDiff) +
  result("Write", "File created successfully.", { id: "t5" }) +
  call(
    "MultiEdit",
    "/Users/lic/ProxyFlash/proxy-flash-admin/src/middleware/auth.ts · 2 edits",
    {
      id: "t7",
      desc: "Route the middleware through the shared clock",
      paths: [
        "/Users/lic/ProxyFlash/proxy-flash-admin/src/middleware/auth.ts",
      ],
      added: 2,
      removed: 2,
    },
  ) +
  diff(authDiff) +
  result("MultiEdit", "Applied 2 edits to auth.ts", { id: "t7" }) +
  call("Bash", "$ /bin/zsh -lc 'pnpm test -- expiry auth'", {
    id: "t6",
    desc: "Re-run the two affected suites",
  }) +
  result(
    "Bash",
    " ✓ tests/expiry.test.ts (2 tests) 9ms\n ✓ tests/auth.test.ts (4 tests) 18ms\n\n Test Files  2 passed (2)\n      Tests  6 passed (6)",
    { id: "t6", exitCode: 0 },
  ) +
  "\nFixed. `verifyJwt` now compares `exp` against the current second, and the middleware no longer re-implements the same check with the wrong claim. Both suites are green."

const projects: Project[] = [
  { id: "p1", name: "proxy-flash-admin", cwd: "/Users/lic/ProxyFlash/proxy-flash-admin", createdAt: now - 5e6 },
  { id: "p2", name: "GiftArena", cwd: "/Users/lic/GiftArena", createdAt: now - 4e6 },
  { id: "p3", name: "landing-site", cwd: "/Users/lic/code/landing-site", createdAt: now - 1e6 },
]

const sessions: SessionMeta[] = [
  { id: "s1", title: "Refactor auth middleware", project: "proxy-flash-admin", provider: "claude", model: "opus", cwd: projects[0].cwd, status: "running", createdAt: now - 3e5, updatedAt: now - 2e4 },
  { id: "s2", title: "Fix webhook retries", project: "proxy-flash-admin", provider: "codex", model: "gpt-5.6-sol", cwd: projects[0].cwd, status: "waiting_input", createdAt: now - 6e5, updatedAt: now - 9e4 },
  { id: "s3", title: "Tune reward curve", project: "GiftArena", provider: "grok", model: "grok-4", cwd: projects[1].cwd, status: "idle", createdAt: now - 8e5, updatedAt: now - 3e5 },
]

const mockAttachments: MessageAttachment[] = [
  { path: "/mock/dashboard.png", name: "dashboard.png", sizeBytes: 348_160, kind: "image", mime: "image/png" },
  { path: "/mock/mobile.png", name: "mobile.png", sizeBytes: 191_488, kind: "image", mime: "image/png" },
  { path: "/mock/error.png", name: "error-state.png", sizeBytes: 88_064, kind: "image", mime: "image/png" },
]

function mockImage(path: string): string | null {
  if (path.includes("error")) return null
  const palette = path.includes("mobile")
    ? ["#7567f8", "#312d63"]
    : ["#32b98f", "#183d3b"]
  const label = path.split("/").pop()?.replace(".png", "") ?? "preview"
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><defs><linearGradient id="g"><stop stop-color="${palette[0]}"/><stop offset="1" stop-color="${palette[1]}"/></linearGradient></defs><rect width="1200" height="760" rx="32" fill="url(#g)"/><rect x="70" y="70" width="1060" height="620" rx="22" fill="#0c1018" opacity=".9"/><rect x="110" y="120" width="250" height="520" rx="14" fill="#171d29"/><rect x="400" y="120" width="680" height="110" rx="14" fill="${palette[0]}" opacity=".28"/><rect x="400" y="265" width="320" height="170" rx="14" fill="#202838"/><rect x="760" y="265" width="320" height="170" rx="14" fill="#202838"/><rect x="400" y="470" width="680" height="170" rx="14" fill="#202838"/><text x="430" y="188" fill="white" font-family="system-ui" font-size="34" font-weight="700">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const messages: Record<string, ChatMessage[]> = {
  s1: [
    { id: "m1", sessionId: "s1", role: "user", content: "Extract the JWT verification into a reusable middleware and add tests.", createdAt: now - 25e4 },
    { id: "m2", sessionId: "s1", role: "assistant", content: "I'll extract the verification logic.\n\n```tool:Edit\nsrc/middleware/auth.ts\n```\n```diff\n- const decoded = jwt.verify(token, process.env.JWT_SECRET)\n- if (!decoded) throw new Error('bad token')\n+ const decoded = verifyJwt(token)\n```\n\nDone — `verifyJwt()` now lives in `auth.ts` and both routes import it. Added 4 tests covering expired, malformed, and valid tokens.", createdAt: now - 24e4, usage: { inputTokens: 13300, outputTokens: 1370, cacheReadTokens: 96000, costUsd: 0.36, durationMs: 21800 } },
    { id: "m8", sessionId: "s1", role: "user", content: "The expiry test is failing. Find out why and fix it.", createdAt: now - 22e4 },
    { id: "m9", sessionId: "s1", role: "assistant", content: busyTurn, createdAt: now - 21e4, usage: { inputTokens: 41200, outputTokens: 3100, cacheReadTokens: 128000, costUsd: 0.71, durationMs: 48300 } },
    { id: "m10", sessionId: "s1", role: "user", content: "Use these three screens as the visual reference for the final polish.", attachments: mockAttachments, createdAt: now - 3e4 },
    { id: "m3", sessionId: "s1", role: "assistant", content: "Running the suite now…", createdAt: now - 2e4, streaming: true },
  ],
  s2: [
    { id: "m4", sessionId: "s2", role: "user", content: "The webhook retry loop gives up after the first 500. Make it back off instead.", createdAt: now - 12e4 },
    { id: "m5", sessionId: "s2", role: "assistant", content: "Switched the retry to exponential backoff with jitter, capped at 5 attempts. I need to run the webhook tests to confirm.", createdAt: now - 9e4, usage: { inputTokens: 5100, outputTokens: 890, costUsd: 0.06, durationMs: 9400 } },
  ],
  s3: [
    { id: "m6", sessionId: "s3", role: "user", content: "Reward curve is too flat past level 30 — players stop grinding there.", createdAt: now - 31e4 },
    { id: "m7", sessionId: "s3", role: "assistant", content: "Raised the late-game slope and re-ran the simulation: median session length goes from 14 to 21 minutes.", createdAt: now - 3e5 },
  ],
}

// s1 is mid-turn, so a follow-up sits in the queue — that is the state the
// composer's queued chips exist for.
const queued: Record<string, QueuedMessage[]> = {
  s1: [
    { id: "q1", sessionId: "s1", text: "Also update the README once tests pass.", createdAt: now - 1e4 },
  ],
}

// Only Claude reports usage in the mock — the point is that a session without
// it (s3, grok) shows no cost chip at all rather than a zero.
const usage: Record<string, SessionUsage> = {
  s1: { turns: 2, inputTokens: 18400, outputTokens: 2260, cacheReadTokens: 96000, costUsd: 0.42, durationMs: 31200 },
  s2: { turns: 1, inputTokens: 5100, outputTokens: 890, costUsd: 0.06, durationMs: 9400 },
}

const permissions: PermissionRequestInfo[] = [
  { requestId: "req1", sessionId: "s2", agentSessionId: "codex-2f1c", source: "codex", summary: "Run `pnpm test -- webhooks`", toolName: "Bash", cwd: projects[0].cwd, createdAt: now - 8e3 },
]

const base = { instanceId: "", homeDir: null as string | null, isExtra: false }
const statuses: ProviderStatus[] = [
  { ...base, id: "claude", instanceId: "claude", label: "Claude Code", installed: true, binaryPath: "/opt/homebrew/bin/claude", version: "1.0.44", auth: "connected", authDetail: "ANTHROPIC_API_KEY set", models: [{ id: "opus", label: "Opus (latest)" }, { id: "sonnet", label: "Sonnet (latest)" }, { id: "haiku", label: "Haiku (latest)" }], defaultModel: "opus", loginCommand: "claude auth login", docsUrl: "https://docs.anthropic.com/en/docs/claude-code", enabled: true, envKeys: ["ANTHROPIC_API_KEY"], envHints: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API key" }] },
  { ...base, id: "claude", instanceId: "inst-work", isExtra: true, homeDir: "/Users/lic/.claude-work", label: "Claude (work)", installed: true, binaryPath: "/opt/homebrew/bin/claude", version: "1.0.44", auth: "connected", authDetail: "Signed in (/Users/lic/.claude-work)", models: [{ id: "opus", label: "Opus (latest)" }, { id: "sonnet", label: "Sonnet (latest)" }], defaultModel: "sonnet", loginCommand: "claude auth login", docsUrl: null, enabled: true, envKeys: [], envHints: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API key" }] },
  { ...base, id: "codex", instanceId: "codex", label: "Codex CLI", installed: true, binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex", version: "codex 0.146.0", auth: "connected", authDetail: "Signed in (~/.codex)", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }, { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }, { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }], defaultModel: "gpt-5.6-sol", loginCommand: "codex login", docsUrl: "https://learn.chatgpt.com/docs/codex", enabled: true, envKeys: [], envHints: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }] },
  { ...base, id: "grok", instanceId: "grok", label: "Grok Build", installed: true, binaryPath: "/Users/lic/.grok/bin/grok", version: "grok 0.9.1", auth: "connected", authDetail: "Signed in (~/.grok)", models: [{ id: "grok-4", label: "Grok 4" }, { id: "grok-3", label: "Grok 3" }], defaultModel: "grok-4", loginCommand: "grok login", docsUrl: null, enabled: false, envKeys: [], envHints: [{ key: "XAI_API_KEY", label: "xAI API key" }, { key: "GROK_API_KEY", label: "Grok API key (alt)" }] },
  { ...base, id: "opencode", instanceId: "opencode", label: "OpenCode", installed: true, binaryPath: "/opt/homebrew/bin/opencode", version: "opencode 0.3.2", auth: "needs_login", authDetail: "0 credentials — run opencode auth login (or use free models)", models: [{ id: "anthropic/claude-sonnet", label: "anthropic/claude-sonnet" }], defaultModel: "anthropic/claude-sonnet", loginCommand: "opencode auth login", docsUrl: "https://opencode.ai", enabled: true, envKeys: [], envHints: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }, { key: "ANTHROPIC_API_KEY", label: "Anthropic API key" }] },
]

const mockInstances: ProviderInstance[] = [
  { id: "inst-work", provider: "claude", label: "Claude (work)", homeDir: "/Users/lic/.claude-work", defaultModel: "sonnet" },
]

const wantWizard =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("wizard")

const settings: SettingsSnapshot = {
  permissionMode: "yolo",
  providers: { claude: { defaultModel: "opus", enabled: true }, grok: { enabled: false } },
  instances: mockInstances,
  general: {
    defaultProvider: "claude",
    defaultEffort: "high",
    editor: "auto",
    onboarded: !wantWizard,
  },
  statuses,
}

const dataPaths = {
  dataDir: "/Users/lic/Library/Application Support/chat-hub/data",
  settingsPath: "/Users/lic/Library/Application Support/chat-hub/data/settings.json",
  statePath: "/Users/lic/Library/Application Support/chat-hub/data/state.json",
  projectsPath: "/Users/lic/Library/Application Support/chat-hub/data/projects.json",
  bridgePath: "/Users/lic/Library/Application Support/agent-desktop/events.jsonl",
  bridgeExists: true,
  bridgeSize: 20480,
  bridgeMtime: now - 20000,
}

const snapshot: SessionSnapshot = wantWizard
  ? {
      sessions: [],
      messages: {},
      queued: {},
      usage: {},
      permissions: [],
      inputRequests: [],
      activeSessionId: null,
    }
  : { sessions, messages, queued, usage, permissions, inputRequests: [], activeSessionId: "s1" }

// Real bytes on disk, served by the dev server: a viewer that only ever sees
// hand-written strings proves nothing about images, video or binary sniffing.
const fixtureAssets = import.meta.glob("../../../fixtures/files-surface/*", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>

// `?url` on a source file hands back the module Vite compiled, not the bytes on
// disk — text fixtures have to come through `?raw` to stay themselves.
const fixtureSources = import.meta.glob(
  "../../../fixtures/files-surface/*.{ts,md,mmd,svg}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>

const FIXTURE_DIR = "fixtures"

const fixtureNames = Object.keys(fixtureAssets)
  .map((path) => path.split("/").pop() ?? path)
  .sort()

function fixtureEntry<T>(table: Record<string, T>, name: string): T | null {
  for (const [path, value] of Object.entries(table)) {
    if (path.endsWith(`/${name}`)) return value
  }
  return null
}

const mockDirs: Record<string, string[]> = {
  "": [
    FIXTURE_DIR,
    "notes",
    "src",
    "tests",
    "README.md",
    "huge.log",
    "package.json",
  ],
  [FIXTURE_DIR]: fixtureNames,
  notes: ["scratch.md"],
  src: ["middleware", "routes", "index.ts"],
  "src/middleware": ["auth.ts"],
  "src/routes": ["session.ts"],
  tests: ["auth.test.ts"],
}

type MockFile = { text: string; truncated?: boolean; binary?: boolean }

const mockFiles: Record<string, MockFile> = {
  "README.md": {
    text: "# proxy-flash-admin\n\nAdmin console for the ProxyFlash fleet.\n\n## Running\n\n    pnpm install\n    pnpm dev\n",
  },
  "package.json": {
    text: '{\n  "name": "proxy-flash-admin",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run"\n  }\n}\n',
  },
  "huge.log": {
    text: Array.from(
      { length: 400 },
      (_, i) => `[2026-07-22T15:${String(i % 60).padStart(2, "0")}:12Z] worker=${i % 4} retry scheduled in ${2 ** (i % 6)}s`,
    ).join("\n"),
    truncated: true,
  },
  "notes/scratch.md": {
    text: "- expiry check reads the wrong claim\n- webhook retries: cap at 5\n- ask about the reward curve past level 30\n",
  },
  "src/index.ts": {
    text: 'import { createServer } from "./server"\n\ncreateServer().listen(3000)\n',
  },
  "src/middleware/auth.ts": {
    text: 'import { verifyJwt } from "../lib/jwt"\n\nexport function requireAuth(req, res, next) {\n  const token = req.headers.authorization?.slice(7)\n  if (!token) return res.status(401).end()\n  const decoded = verifyJwt(token)\n  if (!decoded) return res.status(401).end()\n  req.user = decoded\n  next()\n}\n',
  },
  "src/routes/session.ts": {
    text: 'import { Router } from "express"\nimport { requireAuth } from "../middleware/auth"\n\nexport const sessions = Router()\n\nsessions.get("/", requireAuth, (req, res) => {\n  res.json({ user: req.user })\n})\n',
  },
  "tests/auth.test.ts": {
    text: 'import { describe, expect, it } from "vitest"\nimport { verifyJwt } from "../src/lib/jwt"\n\ndescribe("verifyJwt", () => {\n  it("rejects an expired token", () => {\n    expect(verifyJwt(expired)).toBeNull()\n  })\n})\n',
  },
}

const terminalDataListeners = new Set<(chunk: TerminalChunk) => void>()
const terminalExitListeners = new Set<(exit: TerminalExit) => void>()
const livePtys = new Map<string, (data: string) => void>()
let ptySeq = 0

let mockMcpServers: McpServerDef[] = [
  {
    id: "memory",
    name: "memory",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    envKeys: [],
  },
]
let mockMcpEnvKeys: Record<string, string[]> = {}

let mockBoard: Board = {
  todos: [
    { id: "d1", text: "Wire the composer", done: true, createdAt: 1 },
    { id: "d2", text: "Ship the board surface", done: false, createdAt: 2 },
  ],
  notes: [
    { id: "n1", text: "Board file lives at .chathub/board.json", createdAt: 1 },
  ],
  updatedAt: 2,
}

const mockEdits: Record<string, string> = {}
const mockStamps: Record<string, FileStamp> = {}

function stampFor(path: string, size: number): FileStamp {
  const existing = mockStamps[path]
  if (existing) return existing
  const fresh = { mtimeMs: now, size }
  mockStamps[path] = fresh
  return fresh
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("Could not read the fixture"))
    reader.readAsDataURL(blob)
  })
}

function emptyOpened(path: string, type: FileType, size: number): OpenedFile {
  return {
    path,
    absolutePath: `/mock/${path}`,
    kind: type.kind,
    mime: type.mime,
    size,
    stamp: stampFor(path, size),
    text: null,
    truncated: false,
    dataUrl: null,
    streamUrl: null,
    unavailable: null,
  }
}

async function openFixture(relPath: string): Promise<OpenedFile> {
  const name = relPath.slice(FIXTURE_DIR.length + 1)
  const url = fixtureEntry(fixtureAssets, name)
  const source = fixtureEntry(fixtureSources, name)
  if (!url) throw new Error(`Cannot read ${relPath}`)
  const type = fileTypeByExtension(relPath) ?? TEXT_TYPE

  if (source !== null) {
    const text = mockEdits[relPath] ?? source
    const opened = emptyOpened(relPath, type, text.length)
    opened.text = text
    if (type.kind === "image") {
      opened.dataUrl = `data:${type.mime};charset=utf-8,${encodeURIComponent(text)}`
    }
    return opened
  }

  const blob = await (await fetch(url)).blob()
  const opened = emptyOpened(relPath, type, blob.size)
  if (type.kind === "image") opened.dataUrl = await blobToDataUrl(blob)
  if (type.kind === "video" || type.kind === "audio") opened.streamUrl = url
  return opened
}

async function openMockFile(relPath: string): Promise<OpenedFile> {
  if (relPath.startsWith(`${FIXTURE_DIR}/`)) return openFixture(relPath)
  const file = mockFiles[relPath]
  if (!file) throw new Error(`Cannot read ${relPath}`)
  const type = file.binary
    ? BINARY_TYPE
    : (fileTypeByExtension(relPath) ?? TEXT_TYPE)
  const text = mockEdits[relPath] ?? file.text
  const opened = emptyOpened(relPath, type, text.length)
  if (!file.binary) {
    opened.text = text
    opened.truncated = file.truncated ?? false
  }
  return opened
}

function makeSurfaceBridge(): SurfaceBridge {
  return {
    listDir: async (_cwd, relPath) => {
      const names = mockDirs[relPath]
      if (!names) throw new Error(`Not a directory: ${relPath || "."}`)
      return {
        path: relPath,
        entries: names.map((name) => {
          const path = relPath === "" ? name : `${relPath}/${name}`
          if (path in mockDirs) return { name, path, kind: "dir" as const }
          const file = mockFiles[path]
          return file
            ? { name, path, kind: "file" as const, size: file.text.length }
            : { name, path, kind: "file" as const }
        }),
      }
    },
    readFileText: async (_cwd, relPath) => {
      const file = mockFiles[relPath]
      if (!file) throw new Error(`Cannot read ${relPath}`)
      const text = file.binary ? "" : (mockEdits[relPath] ?? file.text)
      return {
        path: relPath,
        text,
        truncated: file.truncated ?? false,
        binary: file.binary ?? false,
        stamp: stampFor(relPath, text.length),
      }
    },
    openFile: async (_cwd, relPath) => openMockFile(relPath),
    saveFile: async (_cwd, relPath, text, stamp) => {
      const current = mockStamps[relPath]
      if (
        current &&
        (current.mtimeMs !== stamp.mtimeMs || current.size !== stamp.size)
      ) {
        throw new Error(`${relPath} ${STALE_WRITE_MESSAGE}`)
      }
      mockEdits[relPath] = text
      const next = { mtimeMs: Date.now(), size: text.length }
      mockStamps[relPath] = next
      return { path: relPath, stamp: next }
    },
    termStart: async (cwd, cols, rows) => {
      const ptyId = `mock-pty-${++ptySeq}`
      const emit = (data: string) => {
        for (const cb of terminalDataListeners) cb({ ptyId, data })
      }
      livePtys.set(ptyId, emit)
      window.setTimeout(() => {
        if (!livePtys.has(ptyId)) return
        emit(`mock pty ${cols}×${rows}\r\n${cwd}\r\n$ `)
      }, 40)
      return { ptyId }
    },
    termWrite: (ptyId, data) => {
      const emit = livePtys.get(ptyId)
      if (!emit) return
      if (data === "\r") {
        emit("\r\n$ ")
        return
      }
      if (data === "\u007f") {
        emit("\b \b")
        return
      }
      emit(data)
    },
    termResize: () => {},
    termKill: (ptyId) => {
      if (!livePtys.delete(ptyId)) return
      for (const cb of terminalExitListeners) cb({ ptyId, exitCode: 0 })
    },
    onTerminalData: (cb) => {
      terminalDataListeners.add(cb)
      return () => {
        terminalDataListeners.delete(cb)
      }
    },
    onTerminalExit: (cb) => {
      terminalExitListeners.add(cb)
      return () => {
        terminalExitListeners.delete(cb)
      }
    },
    boardRead: async () => mockBoard,
    boardWrite: async (_cwd, board) => {
      mockBoard = { ...board, updatedAt: Date.now() }
      return mockBoard
    },
  }
}

export function installDevMock(): void {
  const api: Partial<ChatHubApi> = {
    getSnapshot: async () => snapshot,
    listSessions: async () => sessions,
    getMessages: async (id: string) => messages[id] ?? [],
    loadArchivedMessages: async () => ({
      messages: [],
      hasMore: false,
      hasArchive: false,
    }),
    hasArchivedMessages: async () => false,
    listProviders: async () => [
      { id: "claude", label: "Claude Code", available: true, description: "Real CLI" },
      { id: "codex", label: "Codex CLI", available: true, description: "Real CLI" },
      { id: "grok", label: "Grok Build", available: true, description: "Real CLI" },
      { id: "opencode", label: "OpenCode", available: true, description: "Real CLI" },
      { id: "mock", label: "Mock", available: true, description: "UI testing only" },
    ],
    getSettings: async () => settings,
    getProviderStatuses: async () => statuses,
    listProjects: async () => projects,
    getBridgePath: async () => dataPaths.bridgePath,
    getDataPaths: async () => dataPaths,
    getGitInfo: async () => ({ branch: "main", dirty: true, root: projects[0].cwd }),
    setActiveSession: async () => snapshot,
    setPermissionMode: async (m) => ({ permissionMode: m }),
    setProviderConfig: async () => ({ providers: settings.providers, statuses }),
    addInstance: async () => ({ instances: mockInstances, statuses }),
    updateInstance: async () => ({ instances: mockInstances, statuses }),
    removeInstance: async () => ({ instances: mockInstances, statuses }),
    setGeneralConfig: async (patch) => ({ general: { ...settings.general, ...patch } }),
    revealPath: async () => true,
    wipeSessions: async () => ({ sessions: [], messages: {}, queued: {}, usage: {}, permissions: [], inputRequests: [], activeSessionId: null }),
    resolveInput: async () => true,
    providerLogin: async () => ({ ok: true, command: "…" }),
    testProvider: async (id) => ({
      ok: id !== "opencode",
      detail: id === "opencode" ? "0 credentials — run opencode auth login" : "Responded: OK",
      ms: 1240,
    }),
    setSessionModel: async (id) => sessions.find((s) => s.id === id)!,
    setSessionPermission: async (id, mode) => {
      const s = sessions.find((x) => x.id === id)!
      s.permissionMode = mode
      return s
    },
    setSessionTitle: async (id) => sessions.find((s) => s.id === id)!,
    addProject: async () => ({ project: projects[0], projects }),
    renameProject: async () => projects,
    removeProject: async () => projects,
    pickFolder: async () => "/Users/lic/code/landing-site",
    pickFiles: async () => mockAttachments.map((item) => item.path),
    inspectAttachments: async (paths) => mockAttachments.filter((item) => paths.includes(item.path)),
    getPathForDroppedFile: (file) => `/mock/${file.name}`,
    readImageDataUrl: async (path) => mockImage(path),
    savePastedImage: async () => "/mock/pasted.png",
    createSession: async () => sessions[0],
    sendMessage: async () => {},
    cancelQueued: async (sessionId, queuedId) =>
      (queued[sessionId] ?? []).filter((q) => q.id !== queuedId),
    abortSession: async () => {},
    deleteSession: async () => {},
    openPath: async () => true,
    openInEditor: async () => "code",
    gitCommit: async () => ({ ok: true, output: "" }),
    // Source control has to be inspectable without Electron too — a panel that
    // only renders against a real repo is a panel nobody reviews.
    gitStatus: async (cwd: string) => ({
      root: cwd,
      branch: "main",
      ahead: 2,
      behind: 0,
      files: [
        { path: "src/middleware/auth.ts", index: " ", work: "M" },
        // The busy mock turn edits this one; the changed-files row must be able
        // to land on it from the absolute path the agent reported.
        { path: "src/lib/jwt.ts", index: " ", work: "M" },
        { path: "src/routes/session.ts", index: " ", work: "M" },
        { path: "tests/auth.test.ts", index: "A", work: " " },
        { path: "notes/scratch.md", index: " ", work: "?" },
      ],
    }),
    gitBranches: async () => ({
      current: "main",
      branches: ["main", "v2-multiuser", "hotfix/expiry"],
    }),
    gitDiff: async () =>
      [
        "@@ -12,3 +12,3 @@",
        "-const decoded = jwt.verify(token, process.env.JWT_SECRET)",
        "-if (!decoded) throw new Error('bad token')",
        "+const decoded = verifyJwt(token)",
      ].join("\n"),
    gitStage: async (cwd: string) => api.gitStatus!(cwd),
    gitUnstage: async (cwd: string) => api.gitStatus!(cwd),
    gitCheckout: async () => ({ ok: true, output: "Switched branch" }),
    gitCommitStaged: async () => ({ ok: true, output: "[main abc1234] 1 file changed" }),
    gitPush: async () => ({ ok: true, output: "Everything up-to-date" }),
    gitCreatePr: async () => ({ ok: true, output: "https://github.com/example/chat-hub/pull/1" }),
    onHubEvent: () => () => {},
    mcpList: async () => ({
      config: { version: 1 as const, servers: mockMcpServers },
      statuses: mockMcpServers.map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        transport: s.transport,
        state: s.enabled ? ("ok" as const) : ("disabled" as const),
        detail: s.enabled ? "mock" : "disabled",
        checkedAt: Date.now(),
      })),
      envKeysByServer: mockMcpEnvKeys,
    }),
    mcpUpsert: async (_cwd, server) => {
      const idx = mockMcpServers.findIndex((s) => s.id === server.id)
      if (idx === -1) mockMcpServers.push(server)
      else mockMcpServers[idx] = server
      return api.mcpList!(".")
    },
    mcpRemove: async (_cwd, id) => {
      mockMcpServers = mockMcpServers.filter((s) => s.id !== id)
      delete mockMcpEnvKeys[id]
      return api.mcpList!(".")
    },
    mcpSetEnabled: async (_cwd, id, enabled) => {
      mockMcpServers = mockMcpServers.map((s) =>
        s.id === id ? { ...s, enabled } : s,
      )
      return api.mcpList!(".")
    },
    mcpSetEnv: async (serverId, envPatch) => {
      const keys = new Set(mockMcpEnvKeys[serverId] ?? [])
      for (const [k, v] of Object.entries(envPatch)) {
        if (v === "") keys.delete(k)
        else keys.add(k)
      }
      mockMcpEnvKeys[serverId] = [...keys]
      return mockMcpEnvKeys[serverId]
    },
    mcpMaterialize: async () => ({
      ok: true,
      written: [".mcp.json", ".codex/config.toml"],
      // Demo the one-shot warning in ?mock=1 Settings → Connections.
      unignoredNative: [".mcp.json"],
    }),
    mcpAddGitignore: async (_cwd, paths) => ({
      ok: true,
      path: "/mock/.gitignore",
      added: paths,
    }),
    mcpStatus: async () =>
      mockMcpServers.map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        transport: s.transport,
        state: s.enabled ? ("ok" as const) : ("disabled" as const),
        checkedAt: Date.now(),
      })),
  }
  ;(window as unknown as { chatHub: ChatHubApi }).chatHub = {
    ...api,
    ...makeSurfaceBridge(),
  } as ChatHubApi
  // Stands in for `touch <file>` in a terminal, so the stale-write refusal can
  // be driven from the browser mock the same way it happens in the real app.
  ;(
    window as unknown as { chatHubTouchFile: (path: string) => void }
  ).chatHubTouchFile = (path) => {
    const current = mockStamps[path]
    mockStamps[path] = {
      mtimeMs: Date.now(),
      size: current?.size ?? 0,
    }
  }
}
