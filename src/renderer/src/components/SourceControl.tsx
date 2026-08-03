import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { GitFileChange, GitWorkingCopy } from "@shared/types"
import { matchPath } from "../lib/path-match"

type Props = {
  cwd: string
  /** Bumped by the caller when a turn ends, so the list follows the agent. */
  refreshKey: number
  /** File the transcript asked for; `at` re-selects it on a repeated click. */
  focus?: { path: string; at: number } | null
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

function DiffPane({ text }: { text: string }) {
  const lines = text.split("\n")
  const added = lines.filter((l) => l.startsWith("+") && l[1] !== "+").length
  const removed = lines.filter((l) => l.startsWith("-") && l[1] !== "-").length
  return (
    <div className="scm-diff">
      <div className="scm-diff-head">
        <span className="diff-stat add">+{added}</span>
        <span className="diff-stat del">−{removed}</span>
      </div>
      <pre>
        <code>
          {lines.map((l, i) => {
            const cls =
              l.startsWith("@@") || l.startsWith("diff ") || l.startsWith("#")
                ? "hunk"
                : l.startsWith("+") && !l.startsWith("+++")
                  ? "add"
                  : l.startsWith("-") && !l.startsWith("---")
                    ? "del"
                    : "ctx"
            return (
              <span key={i} className={`diff-line ${cls}`}>
                {l || " "}
                {"\n"}
              </span>
            )
          })}
        </code>
      </pre>
    </div>
  )
}

export function SourceControl({
  cwd,
  refreshKey,
  focus,
  onClose,
  onChanged,
}: Props) {
  const [copy, setCopy] = useState<GitWorkingCopy>(EMPTY)
  const [branches, setBranches] = useState<string[]>([])
  const [selected, setSelected] = useState<Row | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const liveRef = useRef(true)

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  const reload = useCallback(async () => {
    const [next, branchList] = await Promise.all([
      window.chatHub.gitStatus(cwd),
      window.chatHub.gitBranches(cwd),
    ])
    if (!liveRef.current) return
    setCopy(next)
    setBranches(branchList.branches)
  }, [cwd])

  useEffect(() => {
    setSelected(null)
    setDiff(null)
    setNotice(null)
    void reload()
  }, [reload, refreshKey])

  const staged = useMemo(() => stagedRows(copy.files), [copy.files])
  const unstaged = useMemo(() => unstagedRows(copy.files), [copy.files])

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

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setDiff(null)
    void window.chatHub
      .gitDiff(
        cwd,
        selected.file.path,
        selected.staged,
        !selected.staged && selected.code === "?",
      )
      .then((text) => {
        if (!cancelled) setDiff(text)
      })
      .catch((err: unknown) => {
        if (!cancelled) setDiff(`# ${String(err)}`)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, selected])

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

  function fileRow(row: Row) {
    const key = rowKey(row)
    const active = selected ? rowKey(selected) === key : false
    return (
      <li key={key} className={`scm-row ${active ? "active" : ""}`}>
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
        </button>
        <span className="scm-row-actions">
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
      </li>
    )
  }

  const noRepo = copy.root === null

  return (
    <aside className="scm" aria-label="Source control">
      <header className="scm-head">
        <div className="scm-title">Source control</div>
        <button type="button" className="scm-close" title="Close" onClick={onClose}>
          ×
        </button>
      </header>

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
              className="scm-act"
              title="Refresh"
              disabled={busy}
              onClick={() => void reload()}
            >
              ↻
            </button>
          </div>

          {notice ? <div className="scm-notice">{notice}</div> : null}

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

          <div className="scm-diff-wrap">
            {selected ? (
              diff === null ? (
                <p className="scm-hint">Loading diff…</p>
              ) : diff.trim() === "" ? (
                <p className="scm-hint">No textual diff for this change.</p>
              ) : (
                <DiffPane text={diff} />
              )
            ) : (
              <p className="scm-hint">Select a file to see its diff.</p>
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
          </div>
        </>
      )}
    </aside>
  )
}
