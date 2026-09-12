import type { AgentTurnItem } from "@shared/types"
import { describeItem, unwrapShell } from "@shared/live"
import { isPlanToolName, splitToolName } from "@shared/tool-card"
import { isEditTool, type ToolCall } from "./tool-runs"
import { cleanSummary } from "./turn-timeline"
import { looksLikePath } from "./short-path"

/**
 * What the agent is doing, at the grain a reader thinks in. A turn is not a
 * flat list of twenty tool calls; it is "looked around, thought, edited three
 * files, ran the tests, checked the page". `working` is the honest fallback
 * for a step that fits none of the named phases — a git commit, a subagent.
 */
export type WorkPhase =
  | "exploring"
  | "thinking"
  | "editing"
  | "testing"
  | "browsing"
  | "verifying"
  | "working"

export const workPhaseLabel: Record<WorkPhase, string> = {
  exploring: "Exploring",
  thinking: "Thinking",
  editing: "Editing",
  testing: "Testing",
  browsing: "Browsing",
  verifying: "Verifying",
  working: "Working",
}

export type TestOutcome = {
  /** Null while the run is still open. */
  result: "pass" | "fail" | null
  /** Counts the runner printed, when it printed any. */
  passed: number | null
  failed: number | null
}

export type PhaseSegment = {
  phase: WorkPhase
  /** Item ids the segment covers, in order — reasoning included. */
  itemIds: string[]
  /** Steps (non-reasoning items) folded into the segment. */
  count: number
  /** Distinct paths touched, for an editing segment; 0 elsewhere. */
  files: number
  /** Sum of the steps' reported durations; null when none reported one. */
  durationMs: number | null
  /** Something in the segment is still running or queued. */
  open: boolean
  /** The newest reasoning summary attached to the segment. */
  thought: string | null
  /** Only a testing segment carries an outcome. */
  test: TestOutcome | null
  /** What the rail prints: "Exploring 6", "Editing 3 files", "Testing ✓ 2427". */
  label: string
}

export type TurnPhases = {
  segments: PhaseSegment[]
  /** Index of the segment the agent is in; null once everything settled. */
  activeIndex: number | null
}

const EXPLORE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "listdir",
  "list_dir",
  "list_directory",
  "read_file",
  "read_files",
  "search",
  "search_files",
  "codebase_search",
  "file_search",
  "grep_search",
  "find",
  "notebookread",
  "websearch",
  "webfetch",
  "web_search",
  "web_fetch",
  "fetch",
])

const EDIT_TOOLS = new Set([
  "apply_patch",
  "notebookedit",
  "create_file",
  "write_file",
  "write_to_file",
  "replace_in_file",
  "delete_file",
])

const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "execute_command",
  "run_terminal_cmd",
  "run_command",
  "exec",
  "terminal",
])

/** Runners and checkers a shell line can invoke directly. */
const TEST_RUNNER =
  /(^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bunx?\s+)?(?:vitest|jest|mocha|ava|tap|pytest|py\.test|tox|nox|playwright|cypress|tsc|eslint|biome|ruff|flake8|mypy|pyright|pylint|rubocop|rspec|phpunit|golangci-lint|clippy)\b/
/** Package-manager scripts whose name says what they are. */
const TEST_SCRIPT =
  /\b(?:pnpm|npm|yarn|bun)(?:\s+run)?(?:\s+-[\w-]+)*\s+(?:test|tests|lint|typecheck|type-check|check|build|e2e|ci|verify|coverage)(?::[\w-]+)?\b/
/** Language toolchains with a test verb. */
const TEST_TOOLCHAIN =
  /\b(?:cargo\s+(?:test|clippy|check|build)|go\s+(?:test|vet|build)|make\s+(?:test|check|lint|build)|swift\s+(?:test|build)|dotnet\s+(?:test|build)|mvn\s+(?:test|verify|package)|gradlew?\s+(?:test|check|build)|mix\s+test|rake\s+(?:test|spec)|prettier\s+--check)\b/

const READ_COMMAND =
  /^(?:ls|ll|la|tree|cat|bat|head|tail|less|more|wc|stat|file|find|fd|grep|rg|ag|ack|pwd|which|type|du|df|env|printenv|echo|sed\s+-n|git\s+(?:status|log|diff|show|blame|branch|ls-files|grep|rev-parse|remote|stash\s+list))\b/

const CHECK_COMMAND = /^(?:curl|wget|http|httpie|xh|nc|ping|dig|nslookup|lsof|ss|netstat)\b/

const SCREENSHOT = /screenshot|snapshot/

/**
 * The phase of one shell line. Read-only commands are exploration, test and
 * lint runs are testing, network probes are verification; anything else —
 * installs, commits, mkdir — is plain work.
 */
export function shellPhase(command: string): WorkPhase {
  const line = unwrapShell(command).trim()
  if (!line) return "working"
  if (TEST_RUNNER.test(line) || TEST_SCRIPT.test(line) || TEST_TOOLCHAIN.test(line)) {
    return "testing"
  }
  const head = line.replace(/^(?:sudo\s+|time\s+|env\s+(?:\S+=\S+\s+)*)/, "")
  if (CHECK_COMMAND.test(head)) return "verifying"
  if (READ_COMMAND.test(head)) return "exploring"
  return "working"
}

/**
 * The phase of a named tool. `command` is the shell line when the tool is
 * a shell, so `Bash pnpm test` lands in testing rather than "working".
 */
export function toolPhase(name: string, command = ""): WorkPhase {
  const { label, server } = splitToolName(name)
  const lower = label.toLowerCase().replace(/[\s-]+/g, "_")
  // "Plan" and "Review" are what `describeItem` calls those items once the
  // main process has relayed them as a bare label.
  if (isPlanToolName(label) || lower === "plan") return "thinking"
  if (lower === "review") return "verifying"
  if (lower.startsWith("surface_") || lower.startsWith("hub_")) return "verifying"
  if (SCREENSHOT.test(lower)) return "verifying"
  if (
    lower.startsWith("browser_") ||
    /browser|chrome|playwright|puppeteer/.test(server?.toLowerCase() ?? "")
  ) {
    return "browsing"
  }
  if (isEditTool(lower) || EDIT_TOOLS.has(lower)) return "editing"
  if (EXPLORE_TOOLS.has(lower)) return "exploring"
  if (SHELL_TOOLS.has(lower)) return shellPhase(command)
  return "working"
}

/** Null for an item that is not a step at all — a notice, a compaction. */
export function itemPhase(item: AgentTurnItem): WorkPhase | null {
  switch (item.kind) {
    case "reasoning":
    case "plan":
      return "thinking"
    case "file_change":
      return "editing"
    case "command":
      return shellPhase(item.command)
    case "tool":
      return toolPhase(item.name, commandArg(item.arguments))
    case "web_search":
      return "exploring"
    case "review":
      return "verifying"
    case "subagent":
    case "image":
      return "working"
    default:
      return null
  }
}

/** The phase of a tool fence in the prose — the pre-items transcript shape. */
export function callPhase(call: ToolCall): WorkPhase {
  return toolPhase(call.name, call.args.replace(/^\$ /, ""))
}

function commandArg(args: unknown): string {
  if (typeof args === "string") return args
  if (!args || typeof args !== "object") return ""
  const command = (args as Record<string, unknown>).command
  if (typeof command === "string") return command
  return Array.isArray(command) ? command.map(String).join(" ") : ""
}

/**
 * Fold a turn's items into consecutive phase segments. A reasoning item is
 * the thought before the step that follows it, so it rides along with that
 * step's segment instead of cutting "Exploring 6" into six pieces; only a
 * reasoning that nothing has followed yet stands as its own "Thinking".
 */
export function buildTurnPhases(items: AgentTurnItem[] | undefined): TurnPhases {
  const drafts: Draft[] = []
  let thoughts: AgentTurnItem[] = []
  let last: Draft | null = null

  for (const item of items ?? []) {
    if (item.kind === "reasoning") {
      thoughts.push(item)
      continue
    }
    const phase = itemPhase(item)
    if (phase === null) continue
    if (!last || last.phase !== phase) {
      last = { phase, items: [] }
      drafts.push(last)
    }
    last.items.push(...thoughts, item)
    thoughts = []
  }
  if (thoughts.length > 0) drafts.push({ phase: "thinking", items: thoughts })

  const segments = drafts.map(toSegment)
  let activeIndex: number | null = null
  for (let at = segments.length - 1; at >= 0; at -= 1) {
    if (segments[at]!.open) {
      activeIndex = at
      break
    }
  }
  return { segments, activeIndex }
}

type Draft = {
  phase: WorkPhase
  /** Thoughts and steps, in arrival order. */
  items: AgentTurnItem[]
}

function toSegment(draft: Draft): PhaseSegment {
  const { phase, items: all } = draft
  const steps = all.filter((item) => item.kind !== "reasoning")
  const durations = steps
    .map(stepDuration)
    .filter((ms): ms is number => ms !== null)
  const summaries = all
    .map((item) => (item.kind === "reasoning" ? cleanSummary(item.summary) : ""))
    .filter(Boolean)
  const segment: PhaseSegment = {
    phase,
    itemIds: all.map((item) => item.id),
    count: steps.length,
    files: phase === "editing" ? new Set(steps.flatMap(editedPaths)).size : 0,
    durationMs: durations.length
      ? durations.reduce((sum, ms) => sum + ms, 0)
      : null,
    open: all.some(
      (item) => item.status === "running" || item.status === "pending",
    ),
    thought: summaries[summaries.length - 1] ?? null,
    test: phase === "testing" ? segmentTest(steps) : null,
    label: "",
  }
  segment.label = segmentLabel(segment)
  return segment
}

function stepDuration(item: AgentTurnItem): number | null {
  if (item.kind !== "command" && item.kind !== "tool" && item.kind !== "subagent") {
    return null
  }
  return typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
    ? item.durationMs
    : null
}

function editedPaths(item: AgentTurnItem): string[] {
  if (item.kind === "file_change") return item.changes.map((change) => change.path)
  const { detail } = describeItem(item)
  return looksLikePath(detail) ? [detail] : []
}

/** "1 failed" wins over "40 passed" on the same line; "0 failed" says nothing. */
const FAIL_TEXT = /\bFAIL\b|✗|error TS\d+|(?<!\b0 )\bfail(?:ed|ing|ures?)\b/i
const PASSED_COUNT = /\b(\d+)\s+(?:passed|passing)\b/
const FAILED_COUNT = /\b(\d+)\s+(?:failed|failing)\b/

/**
 * Whether a test step passed. The exit code is the runner's own verdict and
 * wins; the output text is the fallback for a CLI that reports none.
 */
export function testResult(item: AgentTurnItem): TestOutcome {
  const output = stepOutput(item)
  const passed = PASSED_COUNT.exec(output)
  const failed = FAILED_COUNT.exec(output)
  const counts = {
    passed: passed ? Number(passed[1]) : null,
    failed: failed ? Number(failed[1]) : null,
  }
  if (item.status === "running" || item.status === "pending") {
    return { result: null, ...counts }
  }
  if (item.status !== "completed") return { result: "fail", ...counts }
  if (item.kind === "command" && typeof item.exitCode === "number") {
    return { result: item.exitCode === 0 ? "pass" : "fail", ...counts }
  }
  if (item.kind === "tool" && item.error) return { result: "fail", ...counts }
  if ((counts.failed ?? 0) > 0 || FAIL_TEXT.test(output)) {
    return { result: "fail", ...counts }
  }
  return { result: "pass", ...counts }
}

function stepOutput(item: AgentTurnItem): string {
  if (item.kind === "command") return item.output ?? ""
  if (item.kind === "tool") {
    if (typeof item.result === "string") return item.result
    return item.result === undefined ? "" : (JSON.stringify(item.result) ?? "")
  }
  return ""
}

/**
 * A segment is only as green as its weakest run, and an open run keeps the
 * verdict pending — a tick that flashes before the failure lands is a lie.
 */
function segmentTest(steps: AgentTurnItem[]): TestOutcome {
  const runs = steps.map(testResult)
  const newest = (key: "passed" | "failed") =>
    [...runs].reverse().find((run) => run[key] !== null)?.[key] ?? null
  const result = runs.some((run) => run.result === "fail")
    ? "fail"
    : runs.some((run) => run.result === null)
      ? null
      : "pass"
  return { result, passed: newest("passed"), failed: newest("failed") }
}

function segmentLabel(segment: PhaseSegment): string {
  const name = workPhaseLabel[segment.phase]
  const counted = segment.count > 1 ? `${name} ${segment.count}` : name
  switch (segment.phase) {
    case "thinking":
      return name
    case "editing":
      if (segment.files === 0) return counted
      return `${name} ${segment.files} ${segment.files === 1 ? "file" : "files"}`
    case "testing": {
      const test = segment.test!
      if (test.result === "fail") {
        return test.failed !== null ? `${name} ✗ ${test.failed}` : `${name} ✗`
      }
      if (test.result === "pass") {
        return test.passed !== null ? `${name} ✓ ${test.passed}` : `${name} ✓`
      }
      return counted
    }
    default:
      return counted
  }
}

