import { splitToolName } from "@shared/tool-card"
import type { AgentTurnItem, TurnItemStatus } from "@shared/types"
import { describeItem } from "./live-step"
import { looksLikePath } from "./short-path"
import { isFailed, type ToolCall } from "./tool-runs"

/**
 * The one shape both transcript feeds fold into. Providers that stream
 * structured `AgentTurnItem`s and providers that emit tool fences in their
 * prose used to group differently — fences grouped, items did not — so a grok
 * exploration phase arrived as twenty identical full-width cards. Both paths
 * now map onto `FeedStep` and share `groupFeed`, and the numbering agrees with
 * the turn timeline because both number the same non-reasoning sequence.
 */

export type FeedStatus = TurnItemStatus

/** The cheap, repetitive kinds. A run of them is one row until asked. */
export type QuietKind = "read" | "grep" | "glob" | "list" | "search" | "fetch"

export type FeedStep = {
  /** Matches `data-item-id` on the card the row stands for. */
  id: string
  /** 1-based position, numbered exactly as the turn timeline numbers its rows. */
  index: number
  /** Which tool ran: "Read", "Grep", "Shell", "Edit". */
  label: string
  /** What it ran on: a path, a pattern, a command. Empty when there is none. */
  detail: string
  /** Set when `detail` is a path, so the row drops its head instead of its tail. */
  path: string | null
  status: FeedStatus
  /** Non-null only for a step cheap enough to fold into a run. */
  quiet: QuietKind | null
}

export type FeedRun = {
  kind: "run"
  key: string
  quiet: QuietKind
  steps: FeedStep[]
}

export type FeedNode = { kind: "step"; key: string; step: FeedStep } | FeedRun

const QUIET_TOOLS: Record<string, QuietKind> = {
  read: "read",
  readfile: "read",
  viewfile: "read",
  notebookread: "read",
  grep: "grep",
  ripgrep: "grep",
  grepsearch: "grep",
  searchtext: "grep",
  glob: "glob",
  filesearch: "glob",
  findfile: "glob",
  ls: "list",
  list: "list",
  listdir: "list",
  listdirectory: "list",
  tree: "list",
  search: "search",
  websearch: "search",
  webquery: "search",
  codebasesearch: "search",
  semanticsearch: "search",
  fetch: "fetch",
  webfetch: "fetch",
  fetchurl: "fetch",
  readurl: "fetch",
}

const RUN_WORDS: Record<QuietKind, { verb: string; one: string; many: string }> = {
  read: { verb: "Read", one: "file", many: "files" },
  grep: { verb: "Searched", one: "pattern", many: "patterns" },
  glob: { verb: "Matched", one: "glob", many: "globs" },
  list: { verb: "Listed", one: "directory", many: "directories" },
  search: { verb: "Ran", one: "web search", many: "web searches" },
  fetch: { verb: "Fetched", one: "page", many: "pages" },
}

const STATUS_WORDS: Record<FeedStatus, string | null> = {
  pending: "queued",
  running: "running",
  // The status dot already says it — a column of COMPLETED says nothing.
  completed: null,
  failed: "failed",
  declined: "declined",
  interrupted: "stopped",
}

/** The word a row prints beside its dot; null when the dot is enough. */
export function statusWord(status: FeedStatus): string | null {
  return STATUS_WORDS[status]
}

export function isUnfinished(status: FeedStatus): boolean {
  return status === "failed" || status === "declined" || status === "interrupted"
}

/** Which cheap kind a tool belongs to; null for anything not known to be cheap. */
export function quietKind(name: string): QuietKind | null {
  const { label } = splitToolName(name)
  return QUIET_TOOLS[label.toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null
}

/** A step that failed, was declined or was interrupted is never folded away. */
function foldable(name: string | null, status: FeedStatus): QuietKind | null {
  if (name === null || isUnfinished(status)) return null
  return quietKind(name)
}

function itemToolName(item: AgentTurnItem): string | null {
  if (item.kind === "tool") return item.name
  if (item.kind === "web_search") return "web_search"
  return null
}

export function stepsFromItems(items: AgentTurnItem[] | undefined): FeedStep[] {
  return (items ?? [])
    .filter((item) => item.kind !== "reasoning")
    .map((item, at) => {
      const { label, detail } = describeItem(item)
      return {
        id: item.id,
        index: at + 1,
        label,
        detail,
        path: looksLikePath(detail) ? detail : null,
        status: item.status,
        quiet: foldable(itemToolName(item), item.status),
      }
    })
}

export function stepsFromCalls(calls: ToolCall[], live = false): FeedStep[] {
  return calls.map((call, at) => {
    const status = callStatus(call, live)
    const paths = call.meta.paths
    return {
      id: call.key,
      index: at + 1,
      label: splitToolName(call.name).label,
      detail: call.title,
      path: paths?.length === 1 ? paths[0]! : null,
      status,
      quiet: foldable(call.name, status),
    }
  })
}

/** A fence with no result is only still running while the turn is. */
function callStatus(call: ToolCall, live: boolean): FeedStatus {
  if (isFailed(call)) return "failed"
  if (call.result === null && live) return "running"
  return "completed"
}

/**
 * Adjacent cheap calls of one kind become a single row. The sequence is never
 * reordered and nothing is dropped, so the numbers still run 1..n down the turn.
 */
export function groupFeed(steps: FeedStep[]): FeedNode[] {
  const out: FeedNode[] = []
  let run: FeedRun | null = null

  for (const step of steps) {
    if (step.quiet === null) {
      run = null
      out.push({ kind: "step", key: step.id, step })
      continue
    }
    if (run && run.quiet === step.quiet) {
      run.steps.push(step)
      continue
    }
    run = { kind: "run", key: `run:${step.id}`, quiet: step.quiet, steps: [step] }
    out.push(run)
  }

  return out
}

export function runLabel(run: FeedRun): string {
  const words = RUN_WORDS[run.quiet]
  const count = run.steps.length
  return `${words.verb} ${count} ${count === 1 ? words.one : words.many}`
}

/** The turn positions the run stands for, so it agrees with the timeline. */
export function runRange(run: FeedRun): string {
  const first = run.steps[0]!.index
  const last = run.steps[run.steps.length - 1]!.index
  return first === last ? `${first}` : `${first}–${last}`
}

/** The run's own dot: the least settled state any of its steps is in. */
export function runStatus(run: FeedRun): FeedStatus {
  if (run.steps.some((step) => step.status === "running")) return "running"
  if (run.steps.some((step) => step.status === "pending")) return "pending"
  return "completed"
}
