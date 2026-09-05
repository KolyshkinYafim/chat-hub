import { attentionEligible } from "@shared/attention"
import type {
  GitCheck,
  GitCheckState,
  GitPrStatus,
  GitPullRequest,
  SessionMeta,
} from "@shared/types"

export type PrStatusByCwd = Readonly<Record<string, GitPrStatus>>

export type FailedCheckLog = { name: string; log: string }

export const LOG_TAIL_CHARS = 8000
export const CHECKS_POLL_INTERVAL_MS = 60_000

const STATE_ORDER: Record<GitCheckState, number> = {
  failure: 0,
  pending: 1,
  success: 2,
  skipped: 3,
}

export function failingChecks(status: GitPrStatus | undefined): GitCheck[] {
  return status?.pr?.checks.filter((check) => check.state === "failure") ?? []
}

export function orderChecks(checks: readonly GitCheck[]): GitCheck[] {
  return [...checks].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name),
  )
}

export function hasFailingChecks(
  session: SessionMeta,
  prByCwd: PrStatusByCwd,
): boolean {
  return attentionEligible(session) && failingChecks(prByCwd[session.cwd]).length > 0
}

export function capLogTail(log: string, maxChars = LOG_TAIL_CHARS): string {
  const trimmed = log.trimEnd()
  if (trimmed.length <= maxChars) return trimmed
  const tail = trimmed.slice(-maxChars)
  const firstBreak = tail.indexOf("\n")
  return `…${firstBreak === -1 ? tail : tail.slice(firstBreak + 1)}`
}

export function buildFailingChecksPrompt(
  branch: string,
  failures: readonly FailedCheckLog[],
): string | null {
  if (failures.length === 0) return null
  const sections = failures.map(
    (failure) =>
      `CI check ${failure.name} failed on ${branch}:\n${capLogTail(failure.log)}`,
  )
  return `${sections.join("\n\n")}\nFix it and re-run the relevant tests.`
}

function logPlaceholder(check: GitCheck): string {
  return check.detailsUrl
    ? `(no log available; see ${check.detailsUrl})`
    : "(no log available)"
}

export async function failingChecksPrompt(
  cwd: string,
  status: GitPrStatus | undefined,
  fetchLog: (cwd: string, runId: string) => Promise<string>,
): Promise<string | null> {
  const pr = status?.pr
  if (!pr) return null
  const failures = await Promise.all(
    failingChecks(status).map(async (check) => ({
      name: check.name,
      log: check.runId
        ? await fetchLog(cwd, check.runId).catch(() => logPlaceholder(check))
        : logPlaceholder(check),
    })),
  )
  return buildFailingChecksPrompt(pr.branch, failures)
}

export function formatCheckDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

export type PrPillTone = "ok" | "warn" | "danger" | "soft"

export type PrPill = { label: string; tone: PrPillTone }

function statePill(pr: GitPullRequest): PrPill {
  if (pr.state === "MERGED") return { label: "merged", tone: "soft" }
  if (pr.state === "CLOSED") return { label: "closed", tone: "danger" }
  return pr.isDraft ? { label: "draft", tone: "soft" } : { label: "open", tone: "ok" }
}

function reviewPill(pr: GitPullRequest): PrPill | null {
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { label: "approved", tone: "ok" }
    case "CHANGES_REQUESTED":
      return { label: "changes requested", tone: "danger" }
    case "REVIEW_REQUIRED":
      return { label: "review required", tone: "warn" }
    default:
      return null
  }
}

function mergeablePill(pr: GitPullRequest): PrPill | null {
  if (pr.mergeable === "CONFLICTING") return { label: "conflicts", tone: "danger" }
  if (pr.mergeable === "MERGEABLE") return { label: "mergeable", tone: "soft" }
  return null
}

export function prPills(pr: GitPullRequest): PrPill[] {
  return [statePill(pr), reviewPill(pr), mergeablePill(pr)].filter(
    (pill): pill is PrPill => pill !== null,
  )
}
