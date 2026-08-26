/**
 * Dev-only mock of the preload `window.chatHub` bridge so the real React UI
 * can be rendered (and screenshotted) in a plain browser tab without Electron.
 * Activated only with `?mock=1` in dev — never ships in the Electron app.
 */
import type {
  AgentInputRequestInfo,
  AgentTurnItem,
  ChatMessage,
  HubEvent,
  MessageAttachment,
  PermissionRequestInfo,
  Project,
  QueuedMessage,
  SessionMeta,
  SessionSnapshot,
  SessionUsage,
  UsageLedgerEntry,
  UsageSummary,
  UsageWindowTotals,
} from "@shared/types"
import type {
  BuildInfo,
  ProviderInstance,
  ProviderStatus,
  SettingsSnapshot,
  StorageStats,
} from "@shared/settings-types"
import type { McpServerDef } from "@shared/mcp"
import type { ProjectScript } from "@shared/scripts"
import {
  ARCHIVE_JUMP_LIMIT,
  ARCHIVE_SEARCH_SCAN_LIMIT,
  excerpt,
  MIN_TRANSCRIPT_QUERY,
  type TranscriptHit,
} from "@shared/search"
import { encodeToolCardMeta, type ToolCardMeta } from "@shared/tool-card"
import {
  BINARY_TYPE,
  TEXT_TYPE,
  fileTypeByExtension,
  type FileType,
} from "@shared/file-kind"
import { STALE_WRITE_MESSAGE } from "@shared/surfaces"
import { hasStoredLayout, MAX_PANES, saveLayout } from "./lib/pane-layout"
import { CONTEXT_DOCS, type ContextDocId } from "@shared/project-context"
import type {
  Board,
  FileStamp,
  OpenedFile,
  ProjectContext,
  ProjectSearchHit,
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
  "> orbit-api@0.1.0 test",
  "> vitest run --reporter verbose",
  "",
  " RUN  v3.2.7 /Users/dev/code/orbit-api",
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
  call("Read", "/Users/dev/code/orbit-api/src/lib/jwt.ts", {
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
  // A short run of reads on the fence path too, so the same folding is
  // reviewable for a provider that emits tool blocks in its prose.
  call("Read", "/Users/dev/code/orbit-api/src/middleware/auth.ts", { id: "t3b" }) +
  result("Read", "export function requireAuth(req, res, next) { … }", { id: "t3b" }) +
  call("Read", "/Users/dev/code/orbit-api/src/routes/session.ts", { id: "t3c" }) +
  result("Read", 'router.post("/session", requireAuth, createSession)', { id: "t3c" }) +
  call("Read", "/Users/dev/code/orbit-api/tests/expiry.test.ts", { id: "t3d" }) +
  result("Read", 'it("rejects a token past its exp", async () => { … })', { id: "t3d" }) +
  "\nThere it is: the guard compares `iat` (issued-at) instead of `exp`, so every token looks expired the moment it is issued. Three files need touching — the check itself, a small clock helper, and the middleware that duplicates the guard.\n\n" +
  call("Edit", "/Users/dev/code/orbit-api/src/lib/jwt.ts", {
    id: "t4",
    desc: "Compare exp, not iat",
    paths: ["/Users/dev/code/orbit-api/src/lib/jwt.ts"],
    added: 3,
    removed: 2,
    absLines: true,
  }) +
  diff(jwtDiff) +
  result("Edit", "The file has been updated.", { id: "t4" }) +
  call("Write", "/Users/dev/code/orbit-api/src/lib/clock.ts", {
    id: "t5",
    paths: ["/Users/dev/code/orbit-api/src/lib/clock.ts"],
    added: 9,
    removed: 0,
    absLines: true,
  }) +
  diff(clockDiff) +
  result("Write", "File created successfully.", { id: "t5" }) +
  call(
    "MultiEdit",
    "/Users/dev/code/orbit-api/src/middleware/auth.ts · 2 edits",
    {
      id: "t7",
      desc: "Route the middleware through the shared clock",
      paths: [
        "/Users/dev/code/orbit-api/src/middleware/auth.ts",
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
  "\nFixed. `verifyJwt` now compares `exp` against the current second, and the middleware no longer re-implements the same check with the wrong claim. Both suites are green. Posted the review note to [MR !61](https://git.example.dev/orbit/orbit-api/-/merge_requests/61#note_21576).\n\nhttps://git.example.dev/orbit/orbit-api/-/merge_requests/61#note_21576"

function fence(lang: string, lines: string[]): string {
  return ["```" + lang, ...lines, "```"].join("\n")
}

const clockSource = [
  "/**",
  " * Every claim in a token is measured in whole seconds since the epoch.",
  " * Milliseconds anywhere in this file is a bug.",
  " */",
  "export const SECOND = 1",
  "export const MINUTE = 60 * SECOND",
  "export const HOUR = 60 * MINUTE",
  "export const DAY = 24 * HOUR",
  "",
  "export type Clock = {",
  "  now(): number",
  "}",
  "",
  "export const systemClock: Clock = {",
  "  now: () => Math.floor(Date.now() / 1000),",
  "}",
  "",
  "export function nowSeconds(clock: Clock = systemClock): number {",
  "  return clock.now()",
  "}",
  "",
  "export function isPast(at: number, clock: Clock = systemClock): boolean {",
  "  return at <= nowSeconds(clock)",
  "}",
  "",
  "export function secondsUntil(at: number, clock: Clock = systemClock): number {",
  "  return Math.max(0, at - nowSeconds(clock))",
  "}",
  "",
  "/* A frozen clock keeps the expiry tests from racing the wall clock. */",
  "export function frozenClock(at: number): Clock {",
  "  return { now: () => at }",
  "}",
  "",
  "export function withSkew(clock: Clock, seconds: number): Clock {",
  "  return { now: () => clock.now() + seconds }",
  "}",
  "",
  "export function formatDuration(seconds: number): string {",
  "  if (seconds < MINUTE) return `${seconds}s`",
  "  if (seconds < HOUR) return `${Math.round(seconds / MINUTE)}m`",
  "  if (seconds < DAY) return `${Math.round(seconds / HOUR)}h`",
  "  return `${Math.round(seconds / DAY)}d`",
  "}",
]

const slowTests = [
  ["checkpoints core", "prunes the ref list down to the newest twenty snapshots", "5 917", "3", "1", "0", "flaky", "tests/checkpoints/prune-refs.test.ts"],
  ["checkpoints core", "reverts modified files and deletes files created after", "2 513", "3", "0", "0", "stable", "tests/checkpoints/revert-tree.test.ts"],
  ["checkpoints core", "snapshots the working tree without dirtying the index", "2 200", "3", "0", "0", "stable", "tests/checkpoints/snapshot-tree.test.ts"],
  ["session cwd", "starts an opted-in session in an isolated worktree", "1 333", "2", "0", "0", "stable", "tests/session/worktree-isolation.test.ts"],
  ["checkpoints core", "never touches a file outside the repository root", "1 652", "3", "0", "0", "stable", "tests/checkpoints/repo-boundary.test.ts"],
  ["per-hunk staging", "stages a hunk of CRLF content byte for byte", "1 086", "1", "0", "0", "stable", "tests/git/hunk-crlf.test.ts"],
  ["per-hunk staging", "rejects a hunk whose content changed on disk", "755", "1", "0", "1", "stable", "tests/git/hunk-stale.test.ts"],
  ["message archive", "spills the oldest message instead of dropping it", "1 006", "2", "0", "0", "stable", "tests/archive/overflow-spill.test.ts"],
  ["message archive", "re-reports the archive after a restart", "469", "2", "0", "0", "stable", "tests/archive/restart-report.test.ts"],
  ["routes", "passes the decoded user downstream to the handler", "444", "1", "0", "0", "stable", "tests/routes/decoded-user.test.ts"],
  ["routes", "rejects a request with no authorization header", "402", "1", "0", "0", "stable", "tests/routes/missing-header.test.ts"],
  ["webhooks", "backs off exponentially after the first 500", "391", "1", "0", "0", "stable", "tests/webhooks/backoff.test.ts"],
  ["webhooks", "gives up after five delivery attempts", "364", "1", "0", "0", "stable", "tests/webhooks/attempt-cap.test.ts"],
  ["webhooks", "keeps the payload byte-identical across retries", "301", "1", "0", "0", "stable", "tests/webhooks/payload-identity.test.ts"],
  ["expiry", "rejects a token whose exp is in the past", "288", "1", "0", "0", "stable", "tests/expiry/past-exp.test.ts"],
  ["expiry", "accepts a token whose exp is still ahead", "244", "1", "0", "0", "stable", "tests/expiry/future-exp.test.ts"],
  ["settings", "round-trips a custom theme through the store", "212", "1", "0", "0", "stable", "tests/settings/theme-roundtrip.test.ts"],
  ["settings", "falls back to the base palette on a bad token", "188", "1", "0", "2", "stable", "tests/settings/theme-fallback.test.ts"],
  ["reward curve", "raises the late-game slope past level thirty", "151", "1", "0", "0", "stable", "tests/reward/late-slope.test.ts"],
  ["reward curve", "leaves the early levels untouched", "122", "1", "0", "0", "stable", "tests/reward/early-levels.test.ts"],
  ["usage ledger", "sums a rolling window of turns", "98", "1", "0", "0", "stable", "tests/usage/window-sum.test.ts"],
  ["usage ledger", "reports zero for a day with no turns", "61", "1", "0", "0", "stable", "tests/usage/empty-day.test.ts"],
]

// One turn that puts every block the renderer knows on screen at once, so a
// browser run of `?mock=1` is a full visual review rather than a spot check.
const richTurn = [
  "## Release readiness",
  "",
  "The auth path is green end to end. The numbers below come from the last full",
  "run on a clean checkout, with the shared clock in place.",
  "",
  "| Suite      | Tests | Failed | Duration | Coverage |",
  "|:-----------|------:|-------:|---------:|:--------:|",
  "| `auth`     | 4     | 0      | 21 ms    | 96%      |",
  "| `routes`   | 6     | 0      | 44 ms    | 91%      |",
  "| `webhooks` | 9     | 0      | 91 ms    | 88%      |",
  "| `expiry`   | 2     | 0      | 9 ms     | 100%     |",
  "| **total**  | 33    | 0      | 1.62 s   | 91%      |",
  "",
  "---",
  "",
  "### How a request reaches a handler",
  "",
  fence("mermaid", [
    "flowchart LR",
    "  A[Request] --> B{Bearer token?}",
    "  B -- no --> R[401 Unauthorized]",
    "  B -- yes --> C[verifyJwt]",
    "  C --> D{exp in the future?}",
    "  D -- no --> R",
    "  D -- yes --> E[Route handler]",
    "  E --> F[(Datastore)]",
  ]),
  "",
  "### What is left",
  "",
  "- [x] Compare `exp` instead of `iat`",
  "- [x] Route the middleware through the shared clock",
  "- [ ] Backfill tokens issued before the fix",
  "  - [ ] Write the migration",
  "  - [ ] Dry-run it against a staging dump",
  "- [ ] Delete the ~~duplicated~~ leftover guard in `src/routes/admin.ts`",
  "",
  "> The backfill is only safe once *every* service reads `exp`. Ship the library",
  "> bump first, wait for the fleet to pick it up, then run it.",
  "",
  "1. Ship the library bump",
  "2. Wait for the fleet to roll over",
  "   1. Watch the error rate for an hour",
  "   2. Compare it against the previous release",
  "3. Run the backfill",
  "",
  "### The clock helper in full",
  "",
  fence("ts", clockSource),
  "",
  "### The change that fixed it",
  "",
  fence("diff", [
    "@@ -12,7 +12,8 @@",
    "  export function verifyJwt(token: string): Claims | null {",
    "    const claims = decode(token)",
    "    if (!claims) return null",
    "-   if (claims.iat < Date.now() / 1000) return null",
    "+   if (isPast(claims.exp)) return null",
    "    return claims",
    "  }",
  ]),
  "",
  "### Slowest tests in the run",
  "",
  "| Suite | Case | ms | Files | Retries | Skips | Verdict | Source |",
  "|---|---|--:|--:|--:|--:|:-:|---|",
  ...slowTests.map((row) => `| ${row.join(" | ")} |`),
  "",
  "### Terms used above",
  "",
  "Token",
  ": A signed claim set the client sends on every request.",
  "",
  "Rotation",
  ": Replacing the signing key without invalidating live sessions.",
  "",
  "Skew",
  ": The seconds of clock drift a verifier tolerates before rejecting a claim.",
  "",
  "#### Shortcuts",
  "",
  "Press `Cmd+K` to jump to a file, `Cmd+Shift+P` for the command palette, and",
  "`Esc` to close whatever is open.",
  "",
  "The middleware lives in `src/middleware/auth.ts` and the helper in",
  "`src/lib/clock.ts`.[^1] Release notes go in the",
  "[changelog](https://git.example.dev/orbit/orbit-api/-/blob/main/CHANGELOG.md).",
  "",
  "[^1]: Both are exported from the package root, so nothing downstream needs a",
  "  path change.",
].join("\n")

const projects: Project[] = [
  { id: "p1", name: "orbit-api", cwd: "/Users/dev/code/orbit-api", createdAt: now - 5e6 },
  { id: "p2", name: "aurora-shop", cwd: "/Users/dev/code/aurora-shop", createdAt: now - 4e6 },
  { id: "p3", name: "landing-site", cwd: "/Users/dev/code/landing-site", createdAt: now - 1e6 },
]

const sessions: SessionMeta[] = [
  { id: "s1", title: "Refactor auth middleware", project: "orbit-api", provider: "claude", model: "opus", cwd: projects[0].cwd, status: "running", createdAt: now - 3e5, updatedAt: now - 2e4 },
  { id: "s2", title: "Fix webhook retries", project: "orbit-api", provider: "codex", model: "gpt-5.6-sol", cwd: projects[0].cwd, status: "waiting_input", favorite: true, createdAt: now - 6e5, updatedAt: now - 9e4 },
  { id: "s3", title: "Tune reward curve", project: "aurora-shop", provider: "grok", model: "grok-4", cwd: projects[1].cwd, status: "idle", favorite: true, settledAt: now - 2e5, settledBy: "user", createdAt: now - 8e5, updatedAt: now - 3e5 },
  // Finished sessions, kept so the Usage tab's top-spend table has a ranking
  // worth looking at rather than a single row.
  { id: "s4", title: "Checkout rewrite", project: "aurora-shop", provider: "claude", model: "opus", cwd: projects[1].cwd, status: "done", createdAt: now - 9e6, updatedAt: now - 26e5 },
  { id: "s5", title: "Migrate billing schema", project: "orbit-api", provider: "claude", model: "sonnet", cwd: projects[0].cwd, status: "done", createdAt: now - 12e6, updatedAt: now - 78e5 },
  { id: "s6", title: "Landing page copy pass", project: "landing-site", provider: "codex", model: "gpt-5.6-terra", cwd: projects[2].cwd, status: "done", createdAt: now - 16e6, updatedAt: now - 12e6 },
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

// The live turn, as a provider that streams structured items reports it: one
// reasoning summary, then tool calls in every state the timeline has to draw —
// finished, failed, running, still queued.
const liveItems: AgentTurnItem[] = [
  {
    id: "li1",
    kind: "reasoning",
    status: "completed",
    summary:
      "Only the expiry suite is red, so the wrong claim is read in one place. Re-running it first to see the assertion, then routing both call sites through the shared clock.",
  },
  {
    id: "li2",
    kind: "command",
    status: "completed",
    command: "pnpm test -- expiry",
    cwd: projects[0].cwd,
    output:
      " ❯ tests/expiry.test.ts (2 tests | 1 failed) 11ms\n   AssertionError: expected null to be an object",
    exitCode: 1,
    durationMs: 4120,
  },
  {
    id: "li3",
    kind: "tool",
    status: "completed",
    name: "Read",
    arguments: { file_path: "src/lib/jwt.ts" },
    result: "export function verifyJwt(token: string) { … }",
    durationMs: 180,
  },
  {
    id: "li4",
    kind: "file_change",
    status: "completed",
    changes: [
      { path: "src/lib/clock.ts", kind: "add", diff: clockDiff.join("\n") },
      { path: "src/lib/jwt.ts", kind: "edit", diff: jwtDiff.join("\n") },
    ],
  },
  {
    id: "li5",
    kind: "tool",
    status: "failed",
    name: "mcp__docs__lookup",
    server: "docs",
    arguments: { query: "jsonwebtoken exp claim" },
    error: "docs server returned 503",
    durationMs: 2600,
  },
  {
    id: "li5b",
    kind: "reasoning",
    status: "completed",
    summary:
      "The docs server is down, so the claim names come from the token spec in the repo instead. Nothing about the fix depends on it.",
  },
  {
    id: "li6",
    kind: "plan",
    status: "completed",
    text: "Route both call sites through the shared clock",
    steps: [
      { text: "Reproduce the expiry failure", status: "completed" },
      { text: "Compare exp instead of iat", status: "completed" },
      { text: "Re-run the affected suites", status: "running" },
    ],
  },
  {
    id: "li7",
    kind: "command",
    status: "running",
    command: "pnpm test -- expiry auth",
    cwd: projects[0].cwd,
  },
  {
    id: "li8",
    kind: "command",
    status: "pending",
    command: "pnpm lint",
    cwd: projects[0].cwd,
  },
]

// A turn that ended, so the timeline can be reviewed as a record rather than a
// live view: ten steps, one of them refused, and enough of them to need the
// "show all" affordance.
const settledItems: AgentTurnItem[] = [
  {
    id: "si1",
    kind: "reasoning",
    status: "completed",
    summary:
      "The retry loop and the backoff table are the only two places that decide when to give up, so both have to move together.",
  },
  { id: "si2", kind: "tool", status: "completed", name: "Grep", arguments: { pattern: "retry", path: "src" }, durationMs: 240 },
  { id: "si3", kind: "tool", status: "completed", name: "Read", arguments: { file_path: "src/webhooks/retry.ts" }, durationMs: 120 },
  { id: "si4", kind: "plan", status: "completed", text: "Back off instead of giving up", steps: [
    { text: "Find every give-up path", status: "completed" },
    { text: "Add exponential backoff", status: "completed" },
    { text: "Cover it with tests", status: "completed" },
  ] },
  { id: "si5", kind: "file_change", status: "completed", changes: [{ path: "src/webhooks/retry.ts", kind: "edit" }] },
  { id: "si6", kind: "command", status: "completed", command: "pnpm test -- webhooks", cwd: projects[0].cwd, output: " ok tests/webhooks (9 tests) 91ms", exitCode: 0, durationMs: 9400 },
  { id: "si7", kind: "tool", status: "declined", name: "Bash", arguments: { command: "rm -rf node_modules" }, error: "Not approved" },
  { id: "si8", kind: "file_change", status: "completed", changes: [{ path: "tests/webhooks/backoff.test.ts", kind: "add" }] },
  { id: "si9", kind: "command", status: "completed", command: "pnpm test -- webhooks", cwd: projects[0].cwd, output: " ok tests/webhooks (12 tests) 118ms", exitCode: 0, durationMs: 11200 },
  { id: "si10", kind: "web_search", status: "completed", query: "webhook retry jitter recommendations" },
  { id: "si11", kind: "review", status: "completed", text: "Backoff caps at five attempts with full jitter." },
]

const retryDiff = [
  "@@ -18,6 +18,11 @@",
  "  export class BaseHttpCollector {",
  "-   protected async get(url: string): Promise<Response> {",
  "-     return fetch(url, { headers: this.headers })",
  "+   protected async get(url: string): Promise<Response> {",
  "+     return withRetry(() => fetch(url, { headers: this.headers }), {",
  "+       attempts: 5,",
  "+       backoff: \"full-jitter\",",
  "+     })",
  "    }",
]

// The exploration phase of a structured-item turn: a long run of reads, a
// couple of greps, one read that failed, an edit and the suite. Before the feed
// grouped, this arrived as eighteen full-width cards under one shared prefix,
// every one of them truncated at the right and reading COMPLETED.
const explorePaths = [
  "src/collectors/http/base-http-collector.ts",
  "src/collectors/http/request-headers.ts",
  "src/collectors/boards/greenhouse.ts",
  "src/collectors/boards/lever.ts",
  "src/collectors/boards/ashby.ts",
  "src/collectors/feeds/wordpress-feed.ts",
  "src/collectors/feeds/algolia-index.ts",
  "src/collectors/registry.ts",
  "src/pipeline/queue/enqueue-batch.ts",
  "src/pipeline/queue/drain-worker.ts",
  "src/pipeline/normalize/posting.ts",
  "src/config/collector-timeouts.ts",
  "src/config/http-defaults.ts",
  "tests/collectors/base-http-collector.test.ts",
]

function exploreRead(path: string, at: number): AgentTurnItem {
  return {
    id: `xr${at}`,
    kind: "tool",
    status: "completed",
    name: "read_file",
    arguments: { file_path: `${projects[0].cwd}/${path}` },
    durationMs: 60 + at * 9,
  }
}

const exploreItems: AgentTurnItem[] = [
  {
    id: "xi1",
    kind: "reasoning",
    status: "completed",
    summary:
      "Every collector goes out through one HTTP base class, so the retry policy belongs there rather than in fourteen call sites.",
  },
  { id: "xi2", kind: "tool", status: "completed", name: "grep", arguments: { pattern: "await fetch\\(", path: "src/collectors" }, durationMs: 210 },
  ...explorePaths.map(exploreRead),
  { id: "xi3", kind: "tool", status: "completed", name: "grep", arguments: { pattern: "collectorTimeoutMs" }, durationMs: 170 },
  { id: "xi4", kind: "tool", status: "failed", name: "read_file", arguments: { file_path: `${projects[0].cwd}/src/collectors/legacy/rss-collector.ts` }, error: "ENOENT: no such file or directory", durationMs: 30 },
  { id: "xi5", kind: "file_change", status: "completed", changes: [{ path: `${projects[0].cwd}/src/collectors/http/base-http-collector.ts`, kind: "edit", diff: retryDiff.join("\n") }] },
  { id: "xi6", kind: "command", status: "completed", command: "pnpm test -- collectors", cwd: projects[0].cwd, output: " ok tests/collectors (21 tests) 340ms", exitCode: 0, durationMs: 8600 },
]

// The turn behind the pending question: the card above the transcript quotes
// its last line and the steps that led there, so both have to be here.
const askedItems: AgentTurnItem[] = [
  { id: "ai1", kind: "tool", status: "completed", name: "Grep", arguments: { pattern: "maxRetryMs", path: "src" }, durationMs: 210 },
  { id: "ai2", kind: "tool", status: "completed", name: "Read", arguments: { file_path: "src/queue/worker.ts" }, durationMs: 140 },
  { id: "ai3", kind: "file_change", status: "completed", changes: [{ path: "src/webhooks/backoff.ts", kind: "add" }] },
]

const messages: Record<string, ChatMessage[]> = {
  s1: [
    { id: "m1", sessionId: "s1", role: "user", content: "Extract the JWT verification into a reusable middleware and add tests.", createdAt: now - 25e4 },
    { id: "m2", sessionId: "s1", role: "assistant", content: "I'll extract the verification logic.\n\n```tool:Edit\nsrc/middleware/auth.ts\n```\n```diff\n- const decoded = jwt.verify(token, process.env.JWT_SECRET)\n- if (!decoded) throw new Error('bad token')\n+ const decoded = verifyJwt(token)\n```\n\nDone — `verifyJwt()` now lives in `auth.ts` and both routes import it. Added 4 tests covering expired, malformed, and valid tokens.", createdAt: now - 24e4, usage: { inputTokens: 13300, outputTokens: 1370, cacheReadTokens: 96000, costUsd: 0.36, durationMs: 21800 } },
    { id: "m8", sessionId: "s1", role: "user", content: "The expiry test is failing. Find out why and fix it.", createdAt: now - 22e4 },
    { id: "m9", sessionId: "s1", role: "assistant", content: busyTurn, createdAt: now - 21e4, usage: { inputTokens: 41200, outputTokens: 3100, cacheReadTokens: 128000, costUsd: 0.71, durationMs: 48300 } },
    { id: "m11", sessionId: "s1", role: "user", content: "Write up where the auth work stands, with the numbers and the request flow.", createdAt: now - 19e4 },
    { id: "m12", sessionId: "s1", role: "assistant", content: richTurn, createdAt: now - 18e4, usage: { inputTokens: 22400, outputTokens: 2600, cacheReadTokens: 111000, costUsd: 0.44, durationMs: 31200 } },
    { id: "m13", sessionId: "s1", role: "user", content: "Make the webhook retry back off instead of giving up on the first failure.", createdAt: now - 17e4 },
    { id: "m14", sessionId: "s1", role: "assistant", content: "Retries now back off exponentially with full jitter and stop after five attempts. The cleanup command I asked for was refused, so `node_modules` is untouched.", createdAt: now - 16e4, items: settledItems, usage: { inputTokens: 18600, outputTokens: 1900, cacheReadTokens: 104000, costUsd: 0.31, durationMs: 26400 } },
    { id: "m15", sessionId: "s1", role: "user", content: "Every collector retries on its own. Find where the HTTP calls actually go out and put one policy behind them.", createdAt: now - 15e4 },
    { id: "m16", sessionId: "s1", role: "assistant", content: "All fourteen collectors go out through `BaseHttpCollector.get()`, so the retry now lives there — five attempts with full jitter. The legacy RSS collector the registry still lists is gone from disk; nothing imports it.", createdAt: now - 14e4, items: exploreItems, usage: { inputTokens: 32800, outputTokens: 2400, cacheReadTokens: 118000, costUsd: 0.52, durationMs: 37100 } },
    { id: "m10", sessionId: "s1", role: "user", content: "Use these three screens as the visual reference for the final polish.", attachments: mockAttachments, createdAt: now - 3e4 },
    { id: "m3", sessionId: "s1", role: "assistant", content: "Running the suite now…", createdAt: now - 2e4, streaming: true, items: liveItems },
  ],
  s2: [
    { id: "m4", sessionId: "s2", role: "user", content: "The webhook retry loop gives up after the first 500. Make it back off instead.", createdAt: now - 12e4 },
    { id: "m5", sessionId: "s2", role: "assistant", content: "Switched the retry to exponential backoff with jitter, capped at 5 attempts. I need to run the webhook tests to confirm.", createdAt: now - 9e4, usage: { inputTokens: 5100, outputTokens: 890, costUsd: 0.06, durationMs: 9400 } },
    { id: "m15", sessionId: "s2", role: "user", content: "Tests are green. Keep the whole retry budget under the queue worker's timeout, though.", createdAt: now - 7e4 },
    { id: "m16", sessionId: "s2", role: "assistant", content: "The five attempts add up to 62 seconds in the worst case, so the budget has to come from a single number both sides read.", createdAt: now - 65e3, usage: { inputTokens: 6400, outputTokens: 720, costUsd: 0.05, durationMs: 7100 } },
    // The Hub's own voice: neither side of the conversation wrote this.
    { id: "m16b", sessionId: "s2", role: "system", content: "Agent opened the Diff panel (src/webhooks/retry.ts).", createdAt: now - 6e4 },
    { id: "m17", sessionId: "s2", role: "user", content: "Pull it into one place then, and leave the dead-letter path alone for now.", createdAt: now - 45e3 },
    { id: "m18", sessionId: "s2", role: "assistant", content: "Moved the backoff table into `src/webhooks/backoff.ts`, which both the client and the worker can import.\n\nThe two of them already disagree about the ceiling: the worker enforces 90s, the webhook client caps its own retries at 120s.", createdAt: now - 3e4, items: askedItems, usage: { inputTokens: 8200, outputTokens: 940, costUsd: 0.07, durationMs: 11800 } },
  ],
  s3: [
    { id: "m6", sessionId: "s3", role: "user", content: "Reward curve is too flat past level 30 — players stop grinding there.", createdAt: now - 31e4 },
    { id: "m7", sessionId: "s3", role: "assistant", content: "Raised the late-game slope and re-ran the simulation: median session length goes from 14 to 21 minutes.", createdAt: now - 3e5 },
  ],
}

/**
 * What s1 spilled out of the live window. Search and scroll-back are only
 * honest once there is more transcript than memory holds, so the mock keeps a
 * deeper archive than one scan covers: "zeppelin" sits inside the scan budget
 * and can be opened, "wintergreen" sits behind it and must be reported missed.
 */
const ARCHIVE_TURNS = 2400
const archivedMessages: Record<string, ChatMessage[]> = {
  s1: Array.from({ length: ARCHIVE_TURNS }, (_, i) => {
    const asked = i % 2 === 0
    let content = asked
      ? `Turn ${i}: check whether the session store still double-writes on retry.`
      : `Turn ${i}: rechecked the store — the retry path writes once, the metric was double-counting.`
    if (i === 50) {
      content = `Turn ${i}: parked the wintergreen migration until the schema lock lands.`
    }
    if (i === 2100) {
      content = `Turn ${i}: the zeppelin deploy script still points at the retired staging host.`
    }
    return {
      id: `a${i}`,
      sessionId: "s1",
      role: asked ? "user" : "assistant",
      content,
      createdAt: now - 26e4 - (ARCHIVE_TURNS - i) * 6e4,
    }
  }),
}

/** Where the caller's own transcript starts, as an index into the archive. */
function mockArchiveEnd(
  all: ChatMessage[],
  beforeMessageId: string | null,
): number {
  if (!beforeMessageId) return all.length
  const idx = all.findIndex((m) => m.id === beforeMessageId)
  return idx === -1 ? all.length : idx
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
  s1: { turns: 2, inputTokens: 18400, outputTokens: 2260, cacheReadTokens: 96000, costUsd: 0.42, durationMs: 31200, contextWindow: 200000, lastTurn: { inputTokens: 5100, outputTokens: 890, cacheReadTokens: 62100, cacheCreateTokens: 2400, durationMs: 9400, contextWindow: 200000 } },
  s2: { turns: 1, inputTokens: 5100, outputTokens: 890, costUsd: 0.06, durationMs: 9400 },
  s4: { turns: 148, inputTokens: 412_000, outputTokens: 96_400, cacheReadTokens: 7_310_000, cacheCreateTokens: 486_000, costUsd: 61.28, durationMs: 4_920_000 },
  s5: { turns: 63, inputTokens: 151_200, outputTokens: 38_900, cacheReadTokens: 2_140_000, cacheCreateTokens: 173_000, costUsd: 18.44, durationMs: 1_760_000 },
  s6: { turns: 27, inputTokens: 88_300, outputTokens: 14_100, cacheReadTokens: 402_000, cacheCreateTokens: 51_000, costUsd: 0, durationMs: 610_000 },
}

// Half a year of ledger rows: enough to fill the 90-day range *and* the 90 days
// it compares against, with weekday rhythm, quiet gaps, and one deliberate spike
// so the chart has something the hover readout can explain.
const mockUsageSummary: UsageSummary = (() => {
  const LEDGER_DAYS = 190
  const SPIKE_OFFSET = 12
  const MIX: { provider: string; model: string; costPerKTok: number; cache: number }[] = [
    { provider: "claude", model: "opus", costPerKTok: 0.042, cache: 14 },
    { provider: "claude", model: "sonnet", costPerKTok: 0.011, cache: 11 },
    { provider: "claude", model: "haiku", costPerKTok: 0.003, cache: 8 },
    { provider: "codex", model: "gpt-5.6-sol", costPerKTok: 0, cache: 6 },
    { provider: "codex", model: "gpt-5.6-terra", costPerKTok: 0, cache: 5 },
    { provider: "grok", model: "grok-4", costPerKTok: 0.004, cache: 0 },
    { provider: "opencode", model: "anthropic/claude-sonnet", costPerKTok: 0.009, cache: 3 },
  ]

  // Seeded LCG: the mock must look the same on every reload, or two screenshots
  // of the same page disagree.
  let seed = 0x5eed_1234
  const rand = (): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
    return seed / 0x1_0000_0000
  }
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]

  // Anchored to the real clock, not the frozen `now`: the Usage tab windows are
  // "last N days from today", so a ledger stuck in the mock's past renders empty.
  const dayStr = (offset: number): string => {
    const d = new Date()
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - offset)
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const dd = String(d.getDate()).padStart(2, "0")
    return `${d.getFullYear()}-${m}-${dd}`
  }
  const weekend = (offset: number): boolean => {
    const d = new Date()
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - offset)
    return d.getDay() === 0 || d.getDay() === 6
  }

  const entries: UsageLedgerEntry[] = []
  for (let offset = LEDGER_DAYS - 1; offset >= 0; offset -= 1) {
    const idle = rand() < (weekend(offset) ? 0.55 : 0.12)
    if (idle) continue
    // Recent weeks are heavier than the archive — a trend the deltas can report.
    const trend = 0.55 + (1 - offset / LEDGER_DAYS) * 0.9
    const burst = offset === SPIKE_OFFSET ? 3.4 : 1
    const rows = 1 + Math.floor(rand() * (weekend(offset) ? 2 : 3))
    const used = new Set<string>()
    for (let r = 0; r < rows; r += 1) {
      const mix = pick(MIX)
      const key = `${mix.provider}/${mix.model}`
      if (used.has(key)) continue
      used.add(key)
      const turns = Math.max(1, Math.round((1 + rand() * 11) * trend * burst))
      const inputTokens = Math.round(turns * (900 + rand() * 5200))
      const outputTokens = Math.round(turns * (400 + rand() * 2400))
      entries.push({
        day: dayStr(offset),
        provider: mix.provider,
        model: mix.model,
        inputTokens,
        outputTokens,
        cacheReadTokens: Math.round(inputTokens * mix.cache),
        cacheCreateTokens: Math.round(inputTokens * mix.cache * 0.08),
        costUsd:
          Math.round(
            ((inputTokens + outputTokens * 4) / 1000) * mix.costPerKTok * 100,
          ) / 100,
        turns,
      })
    }
  }

  const win = (days: number): UsageWindowTotals => {
    const from = dayStr(days - 1)
    return entries
      .filter((e) => e.day >= from)
      .reduce(
        (acc, e) => ({
          inputTokens: acc.inputTokens + e.inputTokens,
          outputTokens: acc.outputTokens + e.outputTokens,
          cacheReadTokens: acc.cacheReadTokens + e.cacheReadTokens,
          cacheCreateTokens: acc.cacheCreateTokens + e.cacheCreateTokens,
          costUsd: acc.costUsd + e.costUsd,
          turns: acc.turns + e.turns,
        }),
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          costUsd: 0,
          turns: 0,
        },
      )
  }
  return { entries, today: win(1), last7d: win(7), last30d: win(30) }
})()

const permissions: PermissionRequestInfo[] = [
  { requestId: "req1", sessionId: "s1", agentSessionId: "claude-2f1c", source: "claude", summary: "Run `pnpm test -- expiry auth`", toolName: "Bash", cwd: projects[0].cwd, createdAt: now - 8e3 },
]

// A live question, on the session whose status is already waiting_input. The
// options carry descriptions and the CLI accepts an answer outside them, so
// the card has to draw both.
const inputRequests: AgentInputRequestInfo[] = [
  {
    requestId: "ask1",
    sessionId: "s2",
    source: "codex",
    createdAt: now - 6e3,
    questions: [
      {
        id: "ceiling",
        header: "Retry ceiling",
        prompt: "Which ceiling should the shared backoff table use?",
        allowOther: true,
        options: [
          { label: "90s — the worker's timeout", description: "Retries always finish before the queue worker gives up. The client stops one attempt earlier than it does today." },
          { label: "120s — the client's current cap", description: "Nothing about the webhook client changes, but the worker can time out mid-retry and the last attempt is wasted." },
          { label: "Read it from config", description: "One setting both sides import, defaulting to 90s. Two more files, and the number has to be decided again per deploy." },
        ],
      },
    ],
  },
]

const base = { instanceId: "", homeDir: null as string | null, isExtra: false }
const statuses: ProviderStatus[] = [
  { ...base, id: "claude", instanceId: "claude", label: "Claude Code", installed: true, binaryPath: "/opt/homebrew/bin/claude", version: "1.0.44", auth: "connected", authDetail: "ANTHROPIC_API_KEY set", models: [{ id: "opus", label: "Opus (latest)" }, { id: "sonnet", label: "Sonnet (latest)" }, { id: "haiku", label: "Haiku (latest)" }], defaultModel: "opus", loginCommand: "claude auth login", docsUrl: "https://docs.anthropic.com/en/docs/claude-code", enabled: true, envKeys: ["ANTHROPIC_API_KEY"], envHints: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API key" }] },
  { ...base, id: "claude", instanceId: "inst-work", isExtra: true, homeDir: "/Users/dev/.claude-work", label: "Claude (work)", installed: true, binaryPath: "/opt/homebrew/bin/claude", version: "1.0.44", auth: "connected", authDetail: "Signed in (/Users/dev/.claude-work)", models: [{ id: "opus", label: "Opus (latest)" }, { id: "sonnet", label: "Sonnet (latest)" }], defaultModel: "sonnet", loginCommand: "claude auth login", docsUrl: null, enabled: true, envKeys: [], envHints: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API key" }] },
  { ...base, id: "codex", instanceId: "codex", label: "Codex CLI", installed: true, binaryPath: "/Applications/ChatGPT.app/Contents/Resources/codex", version: "codex 0.146.0", auth: "connected", authDetail: "Signed in (~/.codex)", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }, { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }, { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }], defaultModel: "gpt-5.6-sol", loginCommand: "codex login", docsUrl: "https://learn.chatgpt.com/docs/codex", enabled: true, envKeys: [], envHints: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }] },
  { ...base, id: "grok", instanceId: "grok", label: "Grok Build", installed: true, binaryPath: "/Users/dev/.grok/bin/grok", version: "grok 0.9.1", auth: "connected", authDetail: "Signed in (~/.grok)", models: [{ id: "grok-4", label: "Grok 4" }, { id: "grok-3", label: "Grok 3" }], defaultModel: "grok-4", loginCommand: "grok login", docsUrl: null, enabled: false, envKeys: [], envHints: [{ key: "XAI_API_KEY", label: "xAI API key" }, { key: "GROK_API_KEY", label: "Grok API key (alt)" }] },
  { ...base, id: "opencode", instanceId: "opencode", label: "OpenCode", installed: true, binaryPath: "/opt/homebrew/bin/opencode", version: "opencode 0.3.2", auth: "needs_login", authDetail: "0 credentials — run opencode auth login (or use free models)", models: [{ id: "anthropic/claude-sonnet", label: "anthropic/claude-sonnet" }], defaultModel: "anthropic/claude-sonnet", loginCommand: "opencode auth login", docsUrl: "https://opencode.ai", enabled: true, envKeys: [], envHints: [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }, { key: "ANTHROPIC_API_KEY", label: "Anthropic API key" }] },
]

const mockInstances: ProviderInstance[] = [
  { id: "inst-work", provider: "claude", label: "Claude (work)", homeDir: "/Users/dev/.claude-work", defaultModel: "sonnet" },
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
  dataDir: "/Users/dev/Library/Application Support/chat-hub/data",
  settingsPath: "/Users/dev/Library/Application Support/chat-hub/data/settings.json",
  statePath: "/Users/dev/Library/Application Support/chat-hub/data/state.json",
  projectsPath: "/Users/dev/Library/Application Support/chat-hub/data/projects.json",
  bridgePath: "/Users/dev/Library/Application Support/agent-desktop/events.jsonl",
  bridgeExists: true,
  bridgeSize: 20480,
  bridgeMtime: now - 20000,
}

const buildInfo: BuildInfo = {
  version: "0.1.0",
  commit: "a1b2c3d",
  builtAt: "2026-08-19T09:41:00Z",
  packaged: true,
  electron: "35.2.1",
  chrome: "134.0.6998.205",
  node: "22.14.0",
  platform: "darwin",
  arch: "arm64",
}

const storageStats: StorageStats = {
  dataDirBytes: 48 * 1024 * 1024 + 512 * 1024,
  fileCount: 187,
  sessionCount: 4,
  archivedSessionCount: 1,
  messageCount: 1362,
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
  : { sessions, messages, queued, usage, permissions, inputRequests, activeSessionId: "s1" }

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
    text: "# orbit-api\n\nAdmin console for the ProxyFlash fleet.\n\n## Running\n\n    pnpm install\n    pnpm dev\n",
  },
  "package.json": {
    text: '{\n  "name": "orbit-api",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run"\n  }\n}\n',
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
const mockMcpEnvKeys: Record<string, string[]> = {}

let mockBoard: Board = {
  todos: [
    { id: "d1", text: "Wire the composer", done: true, status: "done", createdAt: 1 },
    {
      id: "d2",
      text: "Ship the board surface",
      done: false,
      status: "in_progress",
      source: "plan",
      createdAt: 2,
    },
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
  if (type.kind === "video" || type.kind === "audio" || type.kind === "pdf") {
    opened.streamUrl = url
  }
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

function mockParentOf(relPath: string): string {
  const at = relPath.lastIndexOf("/")
  return at === -1 ? "" : relPath.slice(0, at)
}

function mockNameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1)
}

// Starts untrusted so ?mock=1 shows the Grok folder-trust banner.
let mockGrokTrusted = false

// Real prose, not lorem: the context surface is reviewed in ?mock=1, and an
// empty template would hide every wrapping, truncation and token-count problem.
const MOCK_CONTEXT_TEXT: Record<ContextDocId, string> = {
  overview: `# Overview

**orbit-api** — Task orchestration API behind the Orbit dashboard.

Repository: https://github.com/acme/orbit-api

## What it does

Accepts task definitions over HTTP, schedules them onto a worker pool, and
streams status back to the dashboard. "Working" means a task submitted through
\`POST /tasks\` reaches a terminal state and the dashboard sees every transition.

## Where to start

- \`src/\` — the API, one folder per resource
- \`tests/\` — one file per resource, integration-first
`,
  stack: `# Stack

- Languages: TypeScript
- Package manager: pnpm
- Notable dependencies: Fastify, Prisma, Vitest
- Layout: \`src/\`, \`tests/\`

## Commands

- \`pnpm dev\` — vite
- \`pnpm test\` — vitest run

Detected from the repository. Re-detect from the Context panel after a
toolchain change — that button rewrites this file and nothing else.
`,
  conventions: `# Conventions

- Match the surrounding code — copy the nearest existing pattern rather than introducing a new one.
- Run \`pnpm test\` before calling a change done.
- Handlers stay thin: validation in the schema, logic in a service, no database calls in a route.
- Keep changes scoped to what was asked. Flag anything else you notice instead of fixing it in passing.
`,
  focus: `# Current focus

Cutting the dashboard over to the streaming status endpoint. The polling route
stays until the last client is migrated, then it goes.

The task list itself lives on the board (\`.chathub/board.json\`), shown in the
Board panel; open todos are sent to the agent alongside this file.
`,
}

let mockContext: ProjectContext = {
  seeded: true,
  share: true,
  updatedAt: now,
  docs: CONTEXT_DOCS.map((spec) => ({
    id: spec.id,
    file: spec.file,
    title: spec.title,
    text: MOCK_CONTEXT_TEXT[spec.id],
    updatedAt: now,
  })),
}

function patchMockContext(patch: Partial<ProjectContext>): ProjectContext {
  mockContext = { ...mockContext, ...patch, updatedAt: Date.now() }
  return mockContext
}

function makeSurfaceBridge(): SurfaceBridge &
  Pick<ChatHubApi, "scriptsList" | "scriptsSave"> {
  return {
    projectFiles: async () => Object.keys(mockFiles).sort(),
    projectSearch: async (_cwd, query) => {
      const needle = query.toLowerCase()
      if (needle.trim().length === 0) return []
      const hits: ProjectSearchHit[] = []
      for (const [path, file] of Object.entries(mockFiles)) {
        if (file.binary) continue
        const lines = (mockEdits[path] ?? file.text).split("\n")
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= 300) return hits
          if (!lines[i].toLowerCase().includes(needle)) continue
          hits.push({ path, line: i + 1, text: lines[i].trim().slice(0, 200) })
        }
      }
      return hits
    },
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
    createFile: async (_cwd, relPath) => {
      const siblings = mockDirs[mockParentOf(relPath)]
      if (!siblings) {
        throw new Error(`Parent folder not found: ${mockParentOf(relPath) || "."}`)
      }
      if (relPath in mockFiles || relPath in mockDirs) {
        throw new Error(`${relPath} already exists`)
      }
      mockFiles[relPath] = { text: "" }
      siblings.push(mockNameOf(relPath))
      return { path: relPath, stamp: stampFor(relPath, 0) }
    },
    createDirectory: async (_cwd, relPath) => {
      const siblings = mockDirs[mockParentOf(relPath)]
      if (!siblings) {
        throw new Error(`Parent folder not found: ${mockParentOf(relPath) || "."}`)
      }
      if (relPath in mockFiles || relPath in mockDirs) {
        throw new Error(`${relPath} already exists`)
      }
      mockDirs[relPath] = []
      siblings.push(mockNameOf(relPath))
      return { name: mockNameOf(relPath), path: relPath, kind: "dir" }
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
    scriptsList: async () => ({ scripts: [], updatedAt: Date.now() }),
    scriptsSave: async (_cwd: string, scripts: ProjectScript[]) => ({
      scripts,
      updatedAt: Date.now(),
    }),
    browserAttach: async () => false,
    browserDetach: async () => false,
    onBrowserActivity: () => () => {},
    onBrowserOpen: () => () => {},
    onSurfaceOpen: () => () => {},
    reportSurfaceState: () => {},
    grokTrustStatus: async () => ({
      trusted: mockGrokTrusted,
      path: "/Users/mock/.grok/trusted_folders.toml",
    }),
    grokTrustFolder: async () => {
      mockGrokTrusted = true
      return true
    },
    contextRead: async () => mockContext,
    contextWriteDoc: async (_cwd, id, text) =>
      patchMockContext({
        seeded: true,
        docs: mockContext.docs.map((doc) =>
          doc.id === id ? { ...doc, text, updatedAt: Date.now() } : doc,
        ),
      }),
    contextSeed: async (_cwd, id) =>
      patchMockContext({
        seeded: true,
        docs: mockContext.docs.map((doc) =>
          id === undefined || doc.id === id
            ? { ...doc, text: MOCK_CONTEXT_TEXT[doc.id], updatedAt: Date.now() }
            : doc,
        ),
      }),
    contextSetShare: async (_cwd, share) => patchMockContext({ share }),
  }
}

async function mockGitStatus(cwd: string) {
  return {
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
  }
}

async function mockMcpList() {
  return {
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
  }
}

const hubListeners = new Set<(event: HubEvent) => void>()

/**
 * A workspace worth looking at: two panes side by side, so the strip, the pane
 * headers and the focus treatment are all on screen at `?mock=1`. `panes=N`
 * forces a count and re-seeds; without it a layout the reviewer dragged into
 * shape survives a reload, which is how the persistence gets reviewed at all.
 */
function seedWorkspace(): void {
  const asked = new URLSearchParams(window.location.search).get("panes")
  const forced =
    asked === null
      ? null
      : Math.max(1, Math.min(MAX_PANES, Number.parseInt(asked, 10) || 1))
  if (forced === null && hasStoredLayout()) return
  const held = sessions.slice(0, forced ?? 2).map((s) => s.id)
  saveLayout({
    panes: held.map((sessionId, index) => ({
      id: `p${index + 1}`,
      sessionId,
      dockOpen: false,
    })),
    focusedPaneId: "p1",
  })
}

export function installDevMock(): void {
  seedWorkspace()
  const api = {
    getSnapshot: async () => snapshot,
    listSessions: async () => sessions,
    getMessages: async (id: string) => messages[id] ?? [],
    loadArchivedMessages: async (sessionId, beforeMessageId, limit = 50) => {
      const all = archivedMessages[sessionId] ?? []
      if (all.length === 0) {
        return { messages: [], hasMore: false, hasArchive: false }
      }
      const end = mockArchiveEnd(all, beforeMessageId)
      if (end <= 0) return { messages: [], hasMore: false, hasArchive: true }
      const start = Math.max(0, end - Math.max(1, Math.min(limit, 200)))
      return {
        messages: all.slice(start, end),
        hasMore: start > 0,
        hasArchive: true,
      }
    },
    hasArchivedMessages: async (sessionId) =>
      (archivedMessages[sessionId] ?? []).length > 0,
    checkpointList: async () => [],
    checkpointRevert: async () => undefined,
    loadArchiveThrough: async (sessionId, beforeMessageId, targetMessageId) => {
      const all = archivedMessages[sessionId] ?? []
      const end = mockArchiveEnd(all, beforeMessageId)
      const target = all.findIndex((m) => m.id === targetMessageId)
      if (target === -1) {
        return { messages: [], hasMore: end > 0, reachedTarget: false }
      }
      if (target >= end) {
        return { messages: [], hasMore: end > 0, reachedTarget: true }
      }
      let start = Math.max(0, target - 10)
      if (end - start > ARCHIVE_JUMP_LIMIT) start = end - ARCHIVE_JUMP_LIMIT
      return {
        messages: all.slice(start, end),
        hasMore: start > 0,
        reachedTarget: start <= target,
      }
    },
    searchArchivedTranscripts: async (query, loadedFrom) => {
      const q = query.trim()
      if (q.length < MIN_TRANSCRIPT_QUERY) {
        return { hits: [], truncated: false }
      }
      const hits: TranscriptHit[] = []
      let truncated = false
      for (const [sessionId, all] of Object.entries(archivedMessages)) {
        const end = mockArchiveEnd(all, loadedFrom[sessionId] ?? null)
        if (end <= 0) continue
        const start = Math.max(0, end - ARCHIVE_SEARCH_SCAN_LIMIT)
        if (start > 0) truncated = true
        let latest: TranscriptHit | null = null
        let count = 0
        for (let i = end - 1; i >= start; i--) {
          const message = all[i]
          const found = message ? excerpt(message.content, q) : null
          if (!message || !found) continue
          count += 1
          latest ??= { sessionId, messageId: message.id, ...found, hits: 0 }
        }
        if (latest) hits.push({ ...latest, hits: count })
      }
      return { hits, truncated }
    },
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
    getBuildInfo: async () => buildInfo,
    // Slow in the real app (it walks the data folder), so the mock stalls too —
    // the loading state on the Advanced tab has to be reviewable in a browser.
    getStorageStats: async () => {
      await new Promise((r) => setTimeout(r, 600))
      return storageStats
    },
    usageSummary: async () => mockUsageSummary,
    getGitInfo: async () => ({ branch: "main", dirty: true, root: projects[0].cwd }),
    setActiveSession: async () => snapshot,
    setPermissionMode: async (m) => ({ permissionMode: m }),
    setProviderConfig: async () => ({ providers: settings.providers, statuses }),
    addInstance: async () => ({ instances: mockInstances, statuses }),
    updateInstance: async () => ({ instances: mockInstances, statuses }),
    removeInstance: async () => ({ instances: mockInstances, statuses }),
    setGeneralConfig: async (patch) => {
      Object.assign(settings.general, patch)
      return { general: { ...settings.general } }
    },
    revealPath: async () => true,
    wipeSessions: async () => ({ sessions: [], messages: {}, queued: {}, usage: {}, permissions: [], inputRequests: [], activeSessionId: null }),
    resolveInput: async (requestId) => {
      // The real broker withdraws the card the moment it has an answer.
      const request = inputRequests.find((r) => r.requestId === requestId)
      if (!request) return false
      for (const listener of hubListeners) {
        listener({ type: "input.resolved", requestId, sessionId: request.sessionId })
      }
      return true
    },
    providerLogin: async () => ({ ok: true, command: "…" }),
    testProvider: async (id) => ({
      ok: id !== "opencode",
      detail: id === "opencode" ? "0 credentials — run opencode auth login" : "Responded: OK",
      ms: 1240,
    }),
    setSessionModel: async (id) => sessions.find((s) => s.id === id)!,
    applySessionMode: async (id, patch) => {
      const s = sessions.find((x) => x.id === id)!
      Object.assign(s, patch)
      return s
    },
    setSessionPermission: async (id, mode) => {
      const s = sessions.find((x) => x.id === id)!
      s.permissionMode = mode
      return s
    },
    setSessionFavorite: async (id, favorite) => {
      const s = sessions.find((x) => x.id === id)!
      if (favorite) {
        s.favorite = true
      } else {
        delete s.favorite
      }
      return s
    },
    setSessionSettled: async (id, settled) => {
      const s = sessions.find((x) => x.id === id)!
      if (settled) {
        s.settledAt = Date.now()
        s.settledBy = "user"
      } else {
        delete s.settledAt
        delete s.settledBy
      }
      return s
    },
    setSessionArchived: async (id, archived) => {
      const s = sessions.find((x) => x.id === id)!
      if (archived) {
        s.archived = true
        if (s.settledAt === undefined) {
          s.settledAt = Date.now()
          s.settledBy = "user"
        }
      } else {
        delete s.archived
      }
      return s
    },
    migrateArchived: async () => {},
    renameSession: async (id, title) => {
      const s = sessions.find((x) => x.id === id)!
      s.title = title
      s.titleOrigin = "user"
      return s
    },
    regenerateTitle: async (id) => {
      const s = sessions.find((x) => x.id === id)!
      await new Promise((r) => setTimeout(r, 900))
      s.title = "Regenerated mock title"
      s.titleOrigin = "auto"
      return s
    },
    addProject: async () => ({ project: projects[0], projects }),
    renameProject: async () => projects,
    removeProject: async () => projects,
    pickFolder: async () => "/Users/dev/code/landing-site",
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
    gitStatus: mockGitStatus,
    gitBranches: async () => ({
      current: "main",
      branches: ["main", "v2-multiuser", "hotfix/expiry"],
    }),
    gitRepositories: async (cwd: string) => [
      { root: cwd, name: "chat-hub", branch: "main", dirty: true },
    ],
    gitLog: async () =>
      [
        "feat: verify tokens through the shared helper",
        "fix: session route dropped the refresh cookie",
        "chore: pin vitest to the workspace version",
        "feat: first cut of the auth middleware",
      ].map((subject, i) => ({
        sha: `${i}`.repeat(40),
        shortSha: `${i}`.repeat(7),
        subject,
        author: "Mock Dev",
        date: new Date(Date.now() - (i + 1) * 5_400_000).toISOString(),
        refs: i === 0 ? ["HEAD -> main", "origin/main"] : [],
      })),
    gitShow: async (_cwd: string, sha: string) => ({
      sha,
      files: [{ path: "src/lib/jwt.ts", added: 2, removed: 2, binary: false }],
      diff: [
        "diff --git a/src/lib/jwt.ts b/src/lib/jwt.ts",
        "index 111..222 100644",
        "--- a/src/lib/jwt.ts",
        "+++ b/src/lib/jwt.ts",
        "@@ -12,3 +12,3 @@",
        "-const decoded = jwt.verify(token, process.env.JWT_SECRET)",
        "-if (!decoded) throw new Error('bad token')",
        "+const decoded = verifyJwt(token)",
        "+if (!decoded) return unauthorized()",
        "",
      ].join("\n"),
    }),
    gitDiff: async () =>
      [
        "@@ -12,3 +12,3 @@",
        "-const decoded = jwt.verify(token, process.env.JWT_SECRET)",
        "-if (!decoded) throw new Error('bad token')",
        "+const decoded = verifyJwt(token)",
      ].join("\n"),
    gitStage: async (cwd: string) => mockGitStatus(cwd),
    gitUnstage: async (cwd: string) => mockGitStatus(cwd),
    gitWorktrees: async () => [],
    gitInit: async (cwd) => ({ branch: "main", dirty: false, root: cwd }),
    gitRemoveWorktree: async () => ({ ok: true, output: "Worktree removed" }),
    gitPruneWorktrees: async () => ({ ok: true, output: "No stale worktrees" }),
    // Counts matching gitStatus above, so the hunk badges and the publish-gate
    // warning ("3 hunks in 2 files …") render in the browser mock.
    gitHunkSummary: async () => ({
      "src/middleware/auth.ts": { staged: 0, unstaged: 2 },
      "src/lib/jwt.ts": { staged: 0, unstaged: 1 },
      "tests/auth.test.ts": { staged: 1, unstaged: 0 },
    }),
    gitStageHunk: async () => ({ ok: true, output: "Hunk staged" }),
    gitUnstageHunk: async () => ({ ok: true, output: "Hunk unstaged" }),
    gitCheckout: async () => ({ ok: true, output: "Switched branch" }),
    gitCommitStaged: async () => ({ ok: true, output: "[main abc1234] 1 file changed" }),
    gitPush: async () => ({ ok: true, output: "Everything up-to-date" }),
    gitCreatePr: async () => ({ ok: true, output: "https://github.com/example/chat-hub/pull/1" }),
    onHubEvent: (listener) => {
      hubListeners.add(listener)
      return () => hubListeners.delete(listener)
    },
    listPermissions: async () => [],
    resolvePermission: async () => true,
    mcpList: mockMcpList,
    mcpUpsert: async (_cwd, server) => {
      const idx = mockMcpServers.findIndex((s) => s.id === server.id)
      if (idx === -1) mockMcpServers.push(server)
      else mockMcpServers[idx] = server
      return mockMcpList()
    },
    mcpRemove: async (_cwd, id) => {
      mockMcpServers = mockMcpServers.filter((s) => s.id !== id)
      delete mockMcpEnvKeys[id]
      return mockMcpList()
    },
    mcpSetEnabled: async (_cwd, id, enabled) => {
      mockMcpServers = mockMcpServers.map((s) =>
        s.id === id ? { ...s, enabled } : s,
      )
      return mockMcpList()
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
    // No Handy in a browser; pretend it is installed so the Voice button can
    // be driven. Toggles "succeed" — typing into the composer plays the paste.
    voiceAvailable: async () => true,
    voiceToggle: async () => true,
    voiceCancel: async () => true,
  } satisfies Partial<ChatHubApi>
  // Typed, never cast: a preload method with no stub here is a compile error
  // rather than a mock that crashes the moment a component calls it.
  const chatHub: ChatHubApi = { ...api, ...makeSurfaceBridge() }
  ;(window as unknown as { chatHub: ChatHubApi }).chatHub = chatHub
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
  // Stands in for the bridge pushing a turn forward, so item arrival — the one
  // thing that moves the transcript under the reader — can be driven, and
  // measured, from a plain browser tab.
  ;(
    window as unknown as { chatHubEmit: (event: HubEvent) => void }
  ).chatHubEmit = (event) => {
    for (const listener of hubListeners) listener(event)
  }
}
