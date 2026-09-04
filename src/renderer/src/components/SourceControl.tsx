import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import type { GitFileChange, GitHunkSummary, GitRepository, GitWorkingCopy, GitWorktreeInfo } from "@shared/types"
import {
  actionForPath,
  type AgentAction,
} from "../lib/agent-actions"
import {
  addComment,
  listComments,
  onDiffCommentsChanged,
  removeComment,
  updateComment,
  type DiffLineKind,
} from "../lib/diff-comments"
import {
  hashDiff,
  loadViewed,
  reconcileViewed,
  saveViewed,
  withoutViewed,
  withViewed,
  type ViewedMap,
} from "../lib/diff-viewed"
import { isEditableTarget } from "../lib/editable-target"
import { matchPath } from "../lib/path-match"
import { leftBehindWarning } from "../lib/publish-gate"

type Props = {
  cwd: string
  sessionId: string
  /** Bumped by the caller when a turn ends, so the list follows the agent. */
  refreshKey: number
  /** File the transcript asked for; `at` re-selects it on a repeated click. */
  focus?: { path: string; at: number } | null
  /** Session tool trail — optional "why changed" hint per file when linkable. */
  actions?: AgentAction[]
  onClose: () => void
  /** Lets the rest of the app re-read the branch/dirty chip after a write. */
  onChanged: () => void
}

const EMPTY: GitWorkingCopy = {
  root: null,
  branch: "no-git",
  ahead: 0,
  behind: 0,
  files: [],
}

/** git's two status columns, spelled out for a row that has room for a word. */
const CODE_LABEL: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflict",
  "?": "untracked",
}

type Row = { file: GitFileChange; staged: boolean; code: string }

function stagedRows(files: GitFileChange[]): Row[] {
  return files
    .filter((f) => f.index !== " " && f.index !== "?")
    .map((f) => ({ file: f, staged: true, code: f.index }))
}

function unstagedRows(files: GitFileChange[]): Row[] {
  return files
    .filter((f) => f.work !== " ")
    .map((f) => ({ file: f, staged: false, code: f.work }))
}

function rowKey(row: Row): string {
  return `${row.staged ? "s" : "w"}:${row.file.path}`
}

/** Per-hunk action offered on each `@@` line of the rendered diff. */
type HunkAction = {
  label: string
  disabled: boolean
  /** `hunk` is the full displayed hunk — `@@` line plus verbatim body. */
  onApply: (index: number, hunk: string) => void
}

/**
 * Each hunk exactly as it is on screen: from its `@@` line to the next one.
 * This is what an apply sends along, so the main process can refuse to stage
 * anything that no longer matches what the user reviewed.
 */
function displayedHunks(lines: string[]): string[] {
  const body = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines
  const starts = body.flatMap((l, i) => (l.startsWith("@@") ? [i] : []))
  return starts.map((start, i) =>
    body.slice(start, starts[i + 1] ?? body.length).join("\n"),
  )
}

type CommentTarget = { kind: DiffLineKind; line: number; content: string }

function commentTargets(lines: string[]): (CommentTarget | null)[] {
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  return lines.map((l, i) => {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (head) {
      oldLine = Number(head[1])
      newLine = Number(head[2])
      inHunk = true
      return null
    }
    if (!inHunk) return null
    if (i === lines.length - 1 && l === "") return null
    // Only `\ No newline` is a real marker inside a hunk: `+++`/`---` here are
    // ordinary content (`-- sql comment`, `++i;`), and skipping them would both
    // hide their comment affordance and desynchronise every later line number.
    if (l.startsWith("\\")) return null
    if (l.startsWith("diff ") || l.startsWith("#")) {
      inHunk = false
      return null
    }
    if (l.startsWith("+")) {
      return { kind: "add", line: newLine++, content: l.slice(1) }
    }
    if (l.startsWith("-")) {
      return { kind: "del", line: oldLine++, content: l.slice(1) }
    }
    oldLine += 1
    return { kind: "ctx", line: newLine++, content: l.slice(1) }
  })
}

type Commenting = { sessionId: string; file: string }

type ComposeState = { index: number; text: string; editId: string | null }

function DiffPane({
  text,
  hunkAction,
  commenting,
}: {
  text: string
  hunkAction?: HunkAction
  commenting?: Commenting
}) {
  const [compose, setCompose] = useState<ComposeState | null>(null)
  const [, bump] = useState(0)
  useEffect(() => onDiffCommentsChanged(() => bump((v) => v + 1)), [])
  useEffect(() => {
    setCompose(null)
  }, [text, commenting?.file])
  const lines = useMemo(() => text.split("\n"), [text])
  // Always parsed: it is the only reader that tells a hunk's `++i;` from a
  // file header, so the counters and row styling below read it too.
  const targets = useMemo(() => commentTargets(lines), [lines])
  const comments = commenting
    ? listComments(commenting.sessionId).filter((c) => c.file === commenting.file)
    : []
  const added = targets.filter((t) => t?.kind === "add").length
  const removed = targets.filter((t) => t?.kind === "del").length
  const hunks = hunkAction ? displayedHunks(lines) : []
  let hunkIndex = -1

  function saveCompose(target: CommentTarget | null) {
    if (!commenting || !compose) return
    const trimmed = compose.text.trim()
    if (trimmed === "") {
      setCompose(null)
      return
    }
    if (compose.editId) {
      updateComment(commenting.sessionId, compose.editId, trimmed)
    } else if (target) {
      addComment(commenting.sessionId, {
        file: commenting.file,
        line: target.line,
        lineText: target.content,
        kind: target.kind,
        text: trimmed,
      })
    }
    setCompose(null)
  }

  return (
    <div className={`scm-diff ${commenting ? "dcm-enabled" : ""}`}>
      <div className="scm-diff-head">
        <span className="diff-stat add">+{added}</span>
        <span className="diff-stat del">−{removed}</span>
      </div>
      <pre>
        <code>
          {lines.map((l, i) => {
            const isHunkHead = l.startsWith("@@")
            if (isHunkHead) hunkIndex += 1
            const index = hunkIndex
            const target = targets[i] ?? null
            const cls = target
              ? target.kind
              : isHunkHead || l.startsWith("diff ") || l.startsWith("#")
                ? "hunk"
                : "ctx"
            const lineComments = target
              ? comments.filter(
                  (c) => c.kind === target.kind && c.line === target.line,
                )
              : []
            return (
              <Fragment key={i}>
                <span className={`diff-line ${cls}`}>
                  {target ? (
                    <button
                      type="button"
                      className="dcm-add"
                      title="Comment on this line"
                      aria-label={`Comment on line ${target.line}`}
                      onClick={() =>
                        setCompose({ index: i, text: "", editId: null })
                      }
                    >
                      +
                    </button>
                  ) : null}
                  {l || " "}
                  {isHunkHead && hunkAction ? (
                    <button
                      type="button"
                      className="scm-act scm-hunk-act"
                      disabled={hunkAction.disabled}
                      onClick={() => hunkAction.onApply(index, hunks[index] ?? l)}
                    >
                      {hunkAction.label}
                    </button>
                  ) : null}
                  {"\n"}
                </span>
                {lineComments.map((c) => (
                  <span key={c.id} className="dcm-chip">
                    <button
                      type="button"
                      className="dcm-chip-text"
                      title="Edit comment"
                      onClick={() =>
                        setCompose({ index: i, text: c.text, editId: c.id })
                      }
                    >
                      {c.text}
                    </button>
                    <button
                      type="button"
                      className="icon-chip xs ghost danger"
                      title="Delete comment"
                      onClick={() =>
                        commenting
                          ? removeComment(commenting.sessionId, c.id)
                          : undefined
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                {compose?.index === i ? (
                  <span className="dcm-editor">
                    <input
                      autoFocus
                      value={compose.text}
                      placeholder="Comment — Enter saves, Esc cancels"
                      aria-label="Line comment"
                      onChange={(e) =>
                        setCompose({ ...compose, text: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          saveCompose(target)
                        } else if (e.key === "Escape") {
                          setCompose(null)
                        }
                      }}
                    />
                  </span>
                ) : null}
              </Fragment>
            )
          })}
        </code>
      </pre>
    </div>
  )
}

export function SourceControl({
  cwd,
  sessionId,
  refreshKey,
  focus,
  actions = [],
  onClose,
  onChanged,
}: Props) {
  const [copy, setCopy] = useState<GitWorkingCopy>(EMPTY)
  const [repos, setRepos] = useState<GitRepository[]>([])
  const [repoCwd, setRepoCwd] = useState(cwd)
  const [branches, setBranches] = useState<string[]>([])
  const [selected, setSelected] = useState<Row | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  // null: the summary could not be read; the gate says so instead of implying
  // that everything is staged.
  const [hunkSummary, setHunkSummary] = useState<GitHunkSummary | null>({})
  // Bumped after a hunk apply: the shown diff is stale even when the row stays.
  const [diffEpoch, setDiffEpoch] = useState(0)
  const [message, setMessage] = useState("")
  const [prTitle, setPrTitle] = useState("")
  const [prDraft, setPrDraft] = useState(true)
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [viewed, setViewed] = useState<ViewedMap>(() => loadViewed(sessionId))
  const liveRef = useRef(true)
  const viewedRef = useRef(viewed)

  useEffect(() => {
    viewedRef.current = viewed
  }, [viewed])

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  const reload = useCallback(async () => {
    const [next, branchList, worktreeList, hunks] = await Promise.all([
      window.chatHub.gitStatus(repoCwd),
      window.chatHub.gitBranches(repoCwd),
      window.chatHub.gitWorktrees(repoCwd).catch(() => [] as GitWorktreeInfo[]),
      window.chatHub.gitHunkSummary(repoCwd).catch(() => null),
    ])
    if (!liveRef.current) return
    setCopy(next)
    setBranches(branchList.branches)
    setWorktrees(worktreeList)
    setHunkSummary(hunks)
    // A refresh may reveal a different diff or branch; publishing requires an
    // explicit review of the current snapshot.
    setReviewConfirmed(false)
  }, [repoCwd])

  useEffect(() => { setRepoCwd(cwd); void window.chatHub.gitRepositories(cwd).then((found) => { if (!liveRef.current) return; setRepos(found); if (found.length === 1) setRepoCwd(found[0].root) }) }, [cwd])

  useEffect(() => {
    setSelected(null)
    setDiff(null)
    setNotice(null)
    setPrTitle("")
    void reload()
  }, [reload, refreshKey])

  const staged = useMemo(() => stagedRows(copy.files), [copy.files])
  const unstaged = useMemo(() => unstagedRows(copy.files), [copy.files])
  const allRows = useMemo(() => [...staged, ...unstaged], [staged, unstaged])
  const selectedIndex = selected
    ? allRows.findIndex((row) => rowKey(row) === rowKey(selected))
    : -1

  // What the publish gate must own up to: whatever a push would leave behind.
  const gateWarning = useMemo(
    () => leftBehindWarning(hunkSummary, copy.files),
    [hunkSummary, copy.files],
  )

  // A path clicked in the transcript picks its row here; unstaged first, since
  // that is where an edit the agent just made shows up.
  useEffect(() => {
    if (!focus) return
    const row =
      matchPath(unstaged, (r) => r.file.path, focus.path) ??
      matchPath(staged, (r) => r.file.path, focus.path)
    if (row) setSelected(row)
  }, [focus, staged, unstaged])

  useEffect(() => {
    // The selected row survives a reload only if that exact path is still in
    // that exact section — a file that just got staged moves, and holding the
    // old row would show the pre-stage diff of a file that no longer has one.
    if (!selected) return
    const still = (selected.staged ? staged : unstaged).some(
      (r) => r.file.path === selected.file.path,
    )
    if (!still) {
      setSelected(null)
      setDiff(null)
    }
  }, [staged, unstaged, selected])

  const fetchRowDiff = useCallback(
    (row: Row) =>
      window.chatHub.gitDiff(
        cwd,
        row.file.path,
        row.staged,
        !row.staged && row.code === "?",
      ),
    [cwd],
  )

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setDiff(null)
    void fetchRowDiff(selected)
      .then((text) => {
        if (!cancelled) setDiff(text)
      })
      .catch((err: unknown) => {
        if (!cancelled) setDiff(`# ${String(err)}`)
      })
    return () => {
      cancelled = true
    }
  }, [fetchRowDiff, selected, diffEpoch])

  useEffect(() => {
    if (Object.keys(viewedRef.current).length === 0) return
    let cancelled = false
    const rows = [...staged, ...unstaged].filter(
      (row) => rowKey(row) in viewedRef.current,
    )
    void Promise.all(
      rows.map(async (row) => {
        const entry = hunkSummary?.[row.file.path]
        const known = row.staged ? entry?.stagedHash : entry?.unstagedHash
        if (known !== undefined) return [rowKey(row), known] as const
        const text = await fetchRowDiff(row).catch(() => null)
        return [rowKey(row), text === null ? "" : hashDiff(text)] as const
      }),
    ).then((pairs) => {
      if (cancelled || !liveRef.current) return
      const next = reconcileViewed(
        viewedRef.current,
        Object.fromEntries(pairs),
      )
      if (next !== viewedRef.current) setViewed(saveViewed(sessionId, next))
    })
    return () => {
      cancelled = true
    }
  }, [staged, unstaged, hunkSummary, fetchRowDiff, sessionId, diffEpoch])

  async function toggleViewed(row: Row, on: boolean) {
    const key = rowKey(row)
    if (!on) {
      setViewed((curr) => saveViewed(sessionId, withoutViewed(curr, key)))
      return
    }
    const text = await fetchRowDiff(row).catch(() => null)
    if (!liveRef.current || text === null) return
    setViewed((curr) =>
      saveViewed(sessionId, withViewed(curr, key, hashDiff(text))),
    )
    if (selected && rowKey(selected) === key) {
      setSelected(null)
      setDiff(null)
    }
  }

  function stepFile(delta: number) {
    if (allRows.length === 0) return
    const next =
      selectedIndex === -1
        ? delta > 0
          ? 0
          : allRows.length - 1
        : Math.min(allRows.length - 1, Math.max(0, selectedIndex + delta))
    setSelected(allRows[next])
  }

  function handleNavKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (isEditableTarget(event.target)) return
    const delta =
      event.key === "j" || event.key === "ArrowDown"
        ? 1
        : event.key === "k" || event.key === "ArrowUp"
          ? -1
          : 0
    if (delta === 0) return
    event.preventDefault()
    stepFile(delta)
  }

  async function run(
    op: () => Promise<GitWorkingCopy | { ok: boolean; output: string }>,
  ) {
    setBusy(true)
    setNotice(null)
    try {
      const res = await op()
      if ("files" in res) setCopy(res)
      else {
        if (!res.ok) setNotice(res.output)
        await reload()
      }
      onChanged()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      if (liveRef.current) setBusy(false)
    }
  }

  async function initRepo() {
    setBusy(true)
    setNotice(null)
    try {
      await window.chatHub.gitInit(cwd)
      await reload()
      onChanged()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      if (liveRef.current) setBusy(false)
    }
  }

  function stage(paths: string[]) {
    void run(() => window.chatHub.gitStage(cwd, paths))
  }

  function unstage(paths: string[]) {
    void run(() => window.chatHub.gitUnstage(cwd, paths))
  }

  async function applyHunk(row: Row, index: number, hunk: string) {
    setBusy(true)
    setNotice(null)
    try {
      const res = row.staged
        ? await window.chatHub.gitUnstageHunk(cwd, row.file.path, index, hunk)
        : await window.chatHub.gitStageHunk(cwd, row.file.path, index, hunk)
      if (!liveRef.current) return
      if (!res.ok) setNotice(res.output)
      // Success or not, later hunks' offsets may have shifted: re-fetch the
      // diff rather than let a second click reuse stale hunk positions.
      setDiffEpoch((epoch) => epoch + 1)
      await reload()
      onChanged()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      if (liveRef.current) setBusy(false)
    }
  }

  async function commit() {
    const text = message.trim()
    if (!text || staged.length === 0) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await window.chatHub.gitCommitStaged(cwd, text)
      if (!liveRef.current) return
      setNotice(res.output)
      if (res.ok) setMessage("")
      await reload()
      onChanged()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      if (liveRef.current) setBusy(false)
    }
  }

  async function switchBranch(branch: string) {
    if (branch === copy.branch) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await window.chatHub.gitCheckout(cwd, branch)
      if (!liveRef.current) return
      // A dirty tree makes git refuse; its own message is the useful one.
      if (!res.ok) setNotice(res.output)
      await reload()
      onChanged()
    } finally {
      if (liveRef.current) setBusy(false)
    }
  }

  function push() {
    if (!reviewConfirmed) return
    void run(() => window.chatHub.gitPush(cwd))
  }

  function createPr() {
    if (!reviewConfirmed) return
    const title = prTitle.trim() || copy.branch
    void run(() => window.chatHub.gitCreatePr(cwd, title, message.trim(), prDraft))
  }

  function removeWorktree(worktree: GitWorktreeInfo) {
    if (worktree.dirty || worktree.prunable || worktree.path === cwd) return
    void run(() => window.chatHub.gitRemoveWorktree(cwd, worktree.path))
  }

  function pruneWorktrees() {
    void run(() => window.chatHub.gitPruneWorktrees(cwd))
  }

  function fileRow(row: Row) {
    const key = rowKey(row)
    const active = selected ? rowKey(selected) === key : false
    const rowViewed = key in viewed
    // Only show when the trail already links this path to a tool call.
    const why = actionForPath(actions, row.file.path)
    const counts = hunkSummary?.[row.file.path]
    const hunkCount = (row.staged ? counts?.staged : counts?.unstaged) ?? 0
    return (
      <li
        key={key}
        className={`scm-row ${active ? "active" : ""}${rowViewed ? " viewed" : ""}`}
      >
        <button
          type="button"
          className="scm-row-main"
          title={row.file.from ? `${row.file.from} → ${row.file.path}` : row.file.path}
          onClick={() => setSelected(row)}
        >
          <span className={`scm-code code-${row.code === "?" ? "q" : row.code}`}>
            {row.code}
          </span>
          <span className="scm-path">{row.file.path}</span>
          {hunkCount > 0 ? (
            <span className="scm-hunk-count">
              {hunkCount} hunk{hunkCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </button>
        <span className="scm-row-actions">
          {why ? (
            <span
              className="scm-why"
              title={`Why: ${why.summary}`}
              aria-label={`Why changed: ${why.summary}`}
            >
              ◈
            </span>
          ) : null}
          <span className="scm-code-label">{CODE_LABEL[row.code] ?? row.code}</span>
          <button
            type="button"
            className="scm-act"
            disabled={busy}
            title={row.staged ? "Unstage" : "Stage"}
            onClick={() =>
              row.staged ? unstage([row.file.path]) : stage([row.file.path])
            }
          >
            {row.staged ? "−" : "+"}
          </button>
        </span>
        <label
          className={`scm-viewed${rowViewed ? " on" : ""}`}
          title={
            rowViewed
              ? "Viewed — unchecks by itself when this diff changes"
              : "Mark as viewed"
          }
        >
          <input
            type="checkbox"
            checked={rowViewed}
            aria-label={`Viewed: ${row.file.path}`}
            onChange={(e) => void toggleViewed(row, e.currentTarget.checked)}
          />
        </label>
      </li>
    )
  }

  const noRepo = copy.root === null

  return (
    <aside
      className="scm"
      aria-label="Source control"
      tabIndex={-1}
      onKeyDown={handleNavKey}
    >
      <header className="scm-head">
        <div className="scm-title">Source control</div>
        {allRows.length > 0 ? (
          <span
            className="scm-pos"
            title="j / k or arrow keys step between files"
          >
            {selectedIndex >= 0 ? `${selectedIndex + 1}/` : ""}
            {allRows.length} file{allRows.length === 1 ? "" : "s"}
          </span>
        ) : null}
        <button type="button" className="icon-chip ghost scm-close" title="Close" onClick={onClose}>
          ×
        </button>
      </header>
      {repos.length > 0 ? <label className="chip select-chip scm-repo-select"><select value={repoCwd} onChange={(e) => setRepoCwd(e.target.value)} aria-label="Repository">{repos.map((repo) => <option key={repo.root} value={repo.root}>{repo.name} · {repo.branch}{repo.dirty ? " · dirty" : ""}</option>)}</select></label> : null}

      {noRepo ? (
        <div className="scm-empty">
          <p>Not a git repository</p>
          <span className="mono-soft dim">{cwd}</span>
          <button
            type="button"
            className="tb-btn primary scm-init"
            disabled={busy}
            onClick={() => void initRepo()}
          >
            {busy ? "Initializing…" : "Initialize repository"}
          </button>
          {notice ? <span className="scm-notice">{notice}</span> : null}
        </div>
      ) : (
        <>
          <div className="scm-branch-row">
            <label className="chip select-chip" title="Switch branch">
              <select
                value={copy.branch}
                disabled={busy || branches.length === 0}
                aria-label="Branch"
                onChange={(e) => void switchBranch(e.target.value)}
              >
                {branches.includes(copy.branch) ? null : (
                  <option value={copy.branch}>{copy.branch}</option>
                )}
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            {copy.ahead > 0 || copy.behind > 0 ? (
              <span className="scm-track mono-soft" title="Versus upstream">
                {copy.ahead > 0 ? `↑${copy.ahead}` : ""}
                {copy.behind > 0 ? `↓${copy.behind}` : ""}
              </span>
            ) : null}
            <button
              type="button"
              className="icon-chip xs ghost"
              title="Refresh"
              disabled={busy}
              onClick={() => void reload()}
            >
              ↻
            </button>
            <button
              type="button"
              className="scm-act"
              disabled={
                busy ||
                !reviewConfirmed ||
                copy.branch === "HEAD" ||
                copy.branch === "no-git"
              }
              title={reviewConfirmed ? "Push current branch to origin" : "Review the current diff first"}
              onClick={push}
            >
              Push
            </button>
          </div>

          {notice ? <div className="scm-notice">{notice}</div> : null}

          <div className="scm-review-gate">
            <label>
              <input
                type="checkbox"
                checked={reviewConfirmed}
                onChange={(event) => setReviewConfirmed(event.currentTarget.checked)}
                disabled={busy}
              />
              <span>
                <strong>Review before publish</strong>
                <small>Inspect the changed files and diff below before Push or Create PR.</small>
              </span>
            </label>
            {gateWarning ? (
              <small className="scm-gate-warn">{gateWarning}</small>
            ) : null}
          </div>

          <div className="scm-lists">
            <div className="scm-section">
              <div className="scm-section-head">
                <span>Staged ({staged.length})</span>
                {staged.length > 0 ? (
                  <button
                    type="button"
                    className="link-btn"
                    disabled={busy}
                    onClick={() => unstage(staged.map((r) => r.file.path))}
                  >
                    Unstage all
                  </button>
                ) : null}
              </div>
              {staged.length === 0 ? (
                <p className="scm-hint">Nothing staged yet.</p>
              ) : (
                <ul className="scm-files">{staged.map(fileRow)}</ul>
              )}
            </div>

            <div className="scm-section">
              <div className="scm-section-head">
                <span>Changes ({unstaged.length})</span>
                {unstaged.length > 0 ? (
                  <button
                    type="button"
                    className="link-btn"
                    disabled={busy}
                    onClick={() => stage(unstaged.map((r) => r.file.path))}
                  >
                    Stage all
                  </button>
                ) : null}
              </div>
              {unstaged.length === 0 ? (
                <p className="scm-hint">Working tree clean.</p>
              ) : (
                <ul className="scm-files">{unstaged.map(fileRow)}</ul>
              )}
            </div>
          </div>

          {worktrees.length > 1 ? (
            <div className="scm-worktrees">
              <div className="scm-section-head">
                <span>Worktrees ({worktrees.length})</span>
                {worktrees.some((worktree) => worktree.prunable) ? (
                  <button type="button" className="link-btn" disabled={busy} onClick={pruneWorktrees}>
                    Prune stale
                  </button>
                ) : null}
              </div>
              <ul className="scm-worktree-list">
                {worktrees.map((worktree) => {
                  const current = worktree.path === cwd
                  return (
                    <li key={worktree.path} className={current ? "current" : undefined}>
                      <span className="scm-worktree-main">
                        <strong>{worktree.branch}</strong>
                        <small title={worktree.path}>{worktree.path}</small>
                      </span>
                      <span className={`scm-worktree-state ${worktree.dirty ? "dirty" : ""}`}>
                        {current ? "current" : worktree.prunable ? "stale" : worktree.dirty ? "dirty" : "clean"}
                      </span>
                      {!current && !worktree.dirty && !worktree.prunable ? (
                        <button type="button" className="scm-act" disabled={busy} onClick={() => removeWorktree(worktree)}>
                          Remove
                        </button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          <div className="scm-diff-wrap">
            {selected ? (
              diff === null ? (
                <p className="scm-hint">Loading diff…</p>
              ) : diff.trim() === "" ? (
                <p className="scm-hint">No textual diff for this change.</p>
              ) : (
                <DiffPane
                  text={diff}
                  commenting={{ sessionId, file: selected.file.path }}
                  hunkAction={
                    // Plain modifications only: binary, untracked, deleted and
                    // renamed files keep their whole-file stage/unstage.
                    selected.code === "M"
                      ? {
                          label: selected.staged ? "Unstage hunk" : "Stage hunk",
                          disabled: busy,
                          onApply: (index, hunk) =>
                            void applyHunk(selected, index, hunk),
                        }
                      : undefined
                  }
                />
              )
            ) : (
              <p className="scm-hint">
                Select a file to see its diff — <span className="kbd">j</span>{" "}
                <span className="kbd">k</span> step between files.
              </p>
            )}
          </div>

          <div className="scm-commit">
            <textarea
              value={message}
              rows={2}
              placeholder="Commit message (staged files only)"
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void commit()
                }
              }}
            />
            <button
              type="button"
              className="tb-btn primary"
              disabled={busy || staged.length === 0 || !message.trim()}
              title={
                staged.length === 0
                  ? "Stage something first — this never runs add -A"
                  : "Commit staged files (⌘Enter)"
              }
              onClick={() => void commit()}
            >
              Commit {staged.length > 0 ? `(${staged.length})` : ""}
            </button>
            <div className="scm-pr-row">
              <input
                value={prTitle}
                placeholder={`PR title · ${copy.branch}`}
                onChange={(event) => setPrTitle(event.currentTarget.value)}
                disabled={busy}
              />
              <label>
                <input
                  type="checkbox"
                  checked={prDraft}
                  onChange={(event) => setPrDraft(event.currentTarget.checked)}
                  disabled={busy}
                />
                Draft
              </label>
              <button
                type="button"
                className="tb-btn"
                disabled={
                  busy ||
                  !reviewConfirmed ||
                  copy.branch === "HEAD" ||
                  copy.branch === "no-git"
                }
                title={reviewConfirmed ? "Create a pull request" : "Review the current diff first"}
                onClick={createPr}
              >
                Create PR
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
