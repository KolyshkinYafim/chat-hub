import type { GitFileChange, GitHunkSummary } from "@shared/types"

/**
 * The sentence the publish gate owes the reviewer about what a push would
 * leave behind: unstaged hunks, untracked files — which `git diff` cannot
 * count, so they are read off the status list — and, when the summary itself
 * could not be read, an honest "unavailable" instead of a reassuring silence.
 * Returns null only when there is provably nothing to warn about.
 */
export function leftBehindWarning(
  summary: GitHunkSummary | null,
  files: GitFileChange[],
): string | null {
  if (summary === null) {
    return "Unstaged-hunk counts are unavailable — the diff could not be read. Check the Changes list yourself before publishing."
  }
  let hunks = 0
  let hunkFiles = 0
  for (const counts of Object.values(summary)) {
    if (counts.unstaged > 0) {
      hunks += counts.unstaged
      hunkFiles += 1
    }
  }
  const untracked = files.filter((file) => file.work === "?").length
  const parts: string[] = []
  if (hunks > 0) {
    parts.push(
      `${hunks} hunk${hunks === 1 ? "" : "s"} in ${hunkFiles} file${hunkFiles === 1 ? "" : "s"}`,
    )
  }
  if (untracked > 0) {
    parts.push(`${untracked} untracked file${untracked === 1 ? "" : "s"}`)
  }
  if (parts.length === 0) return null
  const verb = hunks + untracked === 1 ? "is" : "are"
  return `${parts.join(" and ")} ${verb} not staged and will not be pushed.`
}
