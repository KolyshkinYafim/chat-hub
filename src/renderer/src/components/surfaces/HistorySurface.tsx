import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { GitCommitDetail, GitLogEntry } from "@shared/types"
import { DiffCard } from "../DiffCard"
import { splitCommitDiff } from "../../lib/commit-diff"
import { formatRelative } from "../../lib/format"
import { errorText } from "../../lib/surface-bridge"

type Props = { cwd: string; refreshKey: number }

/**
 * Read-only walk through the repo's recent commits: pick one, read its diff.
 * Deliberately no reset/revert/checkout — rewriting history stays in the
 * terminal, where git can argue back.
 */
export function HistorySurface({ cwd, refreshKey }: Props) {
  const [repoCwd, setRepoCwd] = useState(cwd)
  const [branch, setBranch] = useState("")
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const liveRef = useRef(true)

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  // Same one-repo resolution as the Diff surface: a session rooted one level
  // above a single checkout should still show that checkout's history.
  useEffect(() => {
    setRepoCwd(cwd)
    void window.chatHub.gitRepositories(cwd).then((found) => {
      if (liveRef.current && found.length === 1) setRepoCwd(found[0].root)
    })
  }, [cwd])

  const reload = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [list, branches] = await Promise.all([
        window.chatHub.gitLog(repoCwd),
        window.chatHub.gitBranches(repoCwd),
      ])
      if (!liveRef.current) return
      setCommits(list)
      setBranch(branches.current)
    } catch (e) {
      if (liveRef.current) setErr(errorText(e))
    } finally {
      if (liveRef.current) setLoading(false)
    }
  }, [repoCwd])

  useEffect(() => {
    setSelected(null)
  }, [repoCwd])

  // refreshKey bumps when a turn finishes — the moment the agent may have
  // just committed — so the list follows without a manual refresh.
  useEffect(() => {
    void reload()
  }, [reload, refreshKey])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let alive = true
    setErr(null)
    void window.chatHub
      .gitShow(repoCwd, selected)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setErr(errorText(e)))
    return () => {
      alive = false
    }
  }, [repoCwd, selected])

  return (
    <div className="history">
      <header className="history-head">
        <span
          className="history-branch"
          title={branch ? `${branch} — ${repoCwd}` : repoCwd}
        >
          {branch || "reading branch…"}
        </span>
        <button
          type="button"
          className="scm-act"
          disabled={loading}
          title="Re-read the log from disk"
          onClick={() => void reload()}
        >
          {loading ? "reading…" : "refresh"}
        </button>
      </header>
      {err ? <div className="scm-notice">{err}</div> : null}
      {loading && commits.length === 0 ? (
        <div className="scm-empty">Reading the log…</div>
      ) : null}
      {!loading && !err && commits.length === 0 ? (
        <div className="scm-empty">
          No commits here yet. The first one will show up as soon as the agent
          or you make it.
        </div>
      ) : null}
      <ul className="history-commits">
        {commits.map((commit) => (
          <li
            key={commit.sha}
            className={selected === commit.sha ? "active" : ""}
          >
            <button
              type="button"
              className="history-row"
              onClick={() =>
                setSelected(selected === commit.sha ? null : commit.sha)
              }
            >
              <span className="history-subject" title={commit.subject}>
                {commit.subject}
              </span>
              <span className="history-meta">
                <code>{commit.shortSha}</code>
                <span>{commit.author}</span>
                <span>{formatRelative(Date.parse(commit.date))}</span>
                {commit.refs.length > 0 ? (
                  <span className="history-refs">{commit.refs.join(" · ")}</span>
                ) : null}
              </span>
            </button>
            {selected === commit.sha ? (
              detail?.sha === commit.sha ? (
                <CommitDetail detail={detail} />
              ) : (
                <div className="scm-empty">Loading this commit…</div>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Whole-commit ceiling: files are capped individually in splitCommitDiff,
 * but a thousand small files would still flood the DOM in one React commit.
 */
const MAX_DETAIL_LINES = 2000

function countLines(text: string): number {
  let n = 1
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") n += 1
  return n
}

function CommitDetail({ detail }: { detail: GitCommitDetail }) {
  const files = useMemo(() => splitCommitDiff(detail.diff), [detail.diff])
  const shown = useMemo(() => {
    let budget = MAX_DETAIL_LINES
    let count = 0
    for (const file of files) {
      const cost = file.diff === "" ? 1 : countLines(file.diff)
      if (count > 0 && cost > budget) break
      budget -= cost
      count += 1
    }
    return count
  }, [files])
  const added = detail.files.reduce((n, f) => n + f.added, 0)
  const removed = detail.files.reduce((n, f) => n + f.removed, 0)
  return (
    <div className="history-detail">
      <div className="history-detail-stat">
        <span>
          {detail.files.length} file{detail.files.length === 1 ? "" : "s"}
        </span>
        <span className="diff-stat add">+{added}</span>
        <span className="diff-stat del">−{removed}</span>
      </div>
      {files.length === 0 ? (
        <div className="scm-empty">Empty commit — nothing changed.</div>
      ) : (
        files.slice(0, shown).map((file) =>
          file.diff ? (
            <DiffCard
              key={file.path}
              path={file.path}
              diff={file.diff}
              absoluteLines
            />
          ) : (
            <div key={file.path} className="history-binary">
              <span className="diff-file-path">{file.path}</span>
              <span className="scm-hint">
                {file.binary ? "binary file" : "no text diff"}
              </span>
            </div>
          ),
        )
      )}
      {shown < files.length ? (
        <div className="scm-empty">
          … {files.length - shown} more files — the commit is too large to
          render in full.
        </div>
      ) : null}
    </div>
  )
}
