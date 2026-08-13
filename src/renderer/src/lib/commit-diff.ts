/** One file's slice of a whole-commit diff, ready for the DiffCard renderer. */
export type CommitFileDiff = {
  path: string
  /** Hunks only — file headers stripped, so parseDiff sees no ---/+++ noise. */
  diff: string
  binary: boolean
}

/**
 * `git show` prints one `diff --git` block per file. Splitting on that marker
 * at line starts is safe: inside hunks every line carries a ` `/`+`/`-`
 * prefix, so file content can never fake a header column-zero.
 */
export function splitCommitDiff(text: string): CommitFileDiff[] {
  const out: CommitFileDiff[] = []
  for (const block of text.split(/^(?=diff --git )/m)) {
    if (!block.startsWith("diff --git ")) continue
    const lines = block.split("\n")
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    const firstHunk = lines.findIndex((line) => line.startsWith("@@ "))
    const header = firstHunk === -1 ? lines : lines.slice(0, firstHunk)
    const path = headerPath(header)
    if (!path) continue
    out.push({
      path,
      diff: firstHunk === -1 ? "" : toRendererFormat(lines.slice(firstHunk)),
      binary: header.some(
        (line) =>
          line.startsWith("Binary files ") || line === "GIT binary patch",
      ),
    })
  }
  return out
}

/**
 * parseDiff reads the transcript's `marker SPACE content` lines, while git
 * emits a bare one-char prefix — re-space the body so DiffCard doesn't eat the
 * first character of every line. `\ No newline at end of file` is dropped: it
 * annotates the byte stream, not the change.
 */
function toRendererFormat(lines: string[]): string {
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith("@@")) out.push(line)
    else if (line.startsWith("\\")) continue
    else out.push(`${line[0] ?? " "} ${line.slice(1)}`)
  }
  return out.join("\n")
}

/**
 * The post-image name: `+++ b/…` normally, the `--- a/…` side for a deletion
 * (where `+++` is /dev/null), and the `diff --git` line itself for binary or
 * mode-only changes that carry neither.
 */
function headerPath(header: string[]): string | null {
  for (const marker of ["+++ ", "--- "]) {
    const line = header.find((l) => l.startsWith(marker))
    if (!line) continue
    const label = unquote(line.slice(4).trim())
    if (label === "/dev/null") continue
    return label.replace(/^[ab]\//, "")
  }
  const m = /^diff --git "?a\/.+?"? "?b\/(.+?)"?$/.exec(header[0] ?? "")
  return m ? m[1]! : null
}

function unquote(label: string): string {
  return label.startsWith('"') && label.endsWith('"') && label.length > 1
    ? label.slice(1, -1)
    : label
}
