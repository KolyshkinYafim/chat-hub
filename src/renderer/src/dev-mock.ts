/**
 * Dev-only mock of the preload `window.chatHub` bridge so the real React UI
 * can be rendered (and screenshotted) in a plain browser tab without Electron.
 * Activated only with `?mock=1` in dev — never ships in the Electron app.
 */
import type {
  ChatMessage,
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
import { encodeToolCardMeta, type ToolCardMeta } from "@shared/tool-card"
import type {
  Board,
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

function diff(code: string): string {
  return `\`\`\`diff\n${code}\n\`\`\`\n\n`
}

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
  "\nThere it is: the guard compares `iat` (issued-at) instead of `exp`, so every token looks expired the moment it is issued. Two files need the fix — the check itself and the middleware that duplicates it.\n\n" +
  call("Edit", "/Users/lic/ProxyFlash/proxy-flash-admin/src/lib/jwt.ts", {
    id: "t4",
    desc: "Compare exp, not iat",
    paths: ["/Users/lic/ProxyFlash/proxy-flash-admin/src/lib/jwt.ts"],
    added: 2,
    removed: 1,
  }) +
  diff(
    [
      "-   if (claims.iat < Date.now() / 1000) return null",
      "+   const nowSeconds = Math.floor(Date.now() / 1000)",
      "+   if (claims.exp <= nowSeconds) return null",
    ].join("\n"),
  ) +
  result("Edit", "The file has been updated.", { id: "t4" }) +
  call(
    "Edit",
    "/Users/lic/ProxyFlash/proxy-flash-admin/src/middleware/auth.ts",
    {
      id: "t5",
      desc: "Drop the duplicated expiry guard",
      paths: [
        "/Users/lic/ProxyFlash/proxy-flash-admin/src/middleware/auth.ts",
      ],
      added: 1,
      removed: 3,
    },
  ) +
  diff(
    [
      "-   const decoded = verifyJwt(token)",
      "-   if (!decoded) return res.status(401).end()",
      "-   if (decoded.iat < Date.now() / 1000) return res.status(401).end()",
      "+   const decoded = verifyJwt(token)",
    ].join("\n"),
  ) +
  result("Edit", "The file has been updated.", { id: "t5" }) +
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
  { id: "s2", title: "Fix webhook retries", project: "proxy-flash-admin", provider: "codex", model: "gpt-5-codex", cwd: projects[0].cwd, status: "waiting_input", createdAt: now - 6e5, updatedAt: now - 9e4 },
  { id: "s3", title: "Tune reward curve", project: "GiftArena", provider: "grok", model: "grok-4", cwd: projects[1].cwd, status: "idle", createdAt: now - 8e5, updatedAt: now - 3e5 },
]

const messages: Record<string, ChatMessage[]> = {
  s1: [
    { id: "m1", sessionId: "s1", role: "user", content: "Extract the JWT verification into a reusable middleware and add tests.", createdAt: now - 25e4 },
    { id: "m2", sessionId: "s1", role: "assistant", content: "I'll extract the verification logic.\n\n```tool:Edit\nsrc/middleware/auth.ts\n```\n```diff\n- const decoded = jwt.verify(token, process.env.JWT_SECRET)\n- if (!decoded) throw new Error('bad token')\n+ const decoded = verifyJwt(token)\n```\n\nDone — `verifyJwt()` now lives in `auth.ts` and both routes import it. Added 4 tests covering expired, malformed, and valid tokens.", createdAt: now - 24e4, usage: { inputTokens: 13300, outputTokens: 1370, cacheReadTokens: 96000, costUsd: 0.36, durationMs: 21800 } },
    { id: "m8", sessionId: "s1", role: "user", content: "The expiry test is failing. Find out why and fix it.", createdAt: now - 22e4 },
    { id: "m9", sessionId: "s1", role: "assistant", content: busyTurn, createdAt: now - 21e4, usage: { inputTokens: 41200, outputTokens: 3100, cacheReadTokens: 128000, costUsd: 0.71, durationMs: 48300 } },
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
  { ...base, id: "codex", instanceId: "codex", label: "Codex CLI", installed: true, binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex", version: "codex 0.4.0", auth: "connected", authDetail: "Signed in (~/.codex)", models: [{ id: "gpt-5-codex", label: "GPT-5 Codex" }, { id: "gpt-5", label: "GPT-5" }, { id: "o4-mini", label: "o4-mini" }], defaultModel: "gpt-5-codex", loginCommand: "codex login", docsUrl: "https://github.com/openai/codex", enabled: true, envKeys: [], envHints: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }] },
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
      activeSessionId: null,
    }
  : { sessions, messages, queued, usage, permissions, activeSessionId: "s1" }

const mockDirs: Record<string, string[]> = {
  "": ["assets", "notes", "src", "tests", "README.md", "huge.log", "package.json"],
  assets: ["logo.png"],
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
  "assets/logo.png": { text: "", binary: true },
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
          return {
            name,
            path,
            kind: "file" as const,
            size: mockFiles[path]?.text.length ?? 0,
          }
        }),
      }
    },
    readFileText: async (_cwd, relPath) => {
      const file = mockFiles[relPath]
      if (!file) throw new Error(`Cannot read ${relPath}`)
      return {
        path: relPath,
        text: file.binary ? "" : file.text,
        truncated: file.truncated ?? false,
        binary: file.binary ?? false,
      }
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
    wipeSessions: async () => ({ sessions: [], messages: {}, queued: {}, usage: {}, permissions: [], activeSessionId: null }),
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
    pickFiles: async () => [],
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
    onHubEvent: () => () => {},
  }
  ;(window as unknown as { chatHub: ChatHubApi }).chatHub = {
    ...api,
    ...makeSurfaceBridge(),
  } as ChatHubApi
}
