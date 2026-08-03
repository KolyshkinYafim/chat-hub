import { useMemo, useState } from "react"
import { parseDiff, type DiffRow } from "../lib/diff-view"
import { languageOf, styleLine } from "../lib/syntax"

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="diff-copy"
      title="Copy the full path"
      onClick={() => {
        void navigator.clipboard
          .writeText(path)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          })
          .catch(() => setCopied(false))
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  )
}

function Line({
  row,
  language,
}: {
  row: DiffRow
  language: string
}) {
  const pieces = useMemo(
    () => styleLine(row.text, language, row.changed),
    [row.text, language, row.changed],
  )
  const marker = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "
  return (
    <div className={`diff-row ${row.kind}`}>
      <span className="diff-num old">{row.oldLine ?? ""}</span>
      <span className="diff-num new">{row.newLine ?? ""}</span>
      <span className="diff-marker">{marker}</span>
      <code className="diff-text">
        {pieces.length === 0 ? (
          " "
        ) : (
          pieces.map((piece, i) => (
            <span
              key={i}
              className={`tok-${piece.cls}${piece.changed ? " tok-changed" : ""}`}
            >
              {piece.text}
            </span>
          ))
        )}
      </code>
    </div>
  )
}

export function DiffCard({
  path,
  diff,
  absoluteLines,
}: {
  path: string
  diff: string
  absoluteLines: boolean
}) {
  const parsed = useMemo(() => parseDiff(diff), [diff])
  const language = useMemo(() => languageOf(path), [path])

  return (
    <div className="diff-card">
      <div className="diff-file">
        <span className="diff-file-path" title={path}>
          {path}
        </span>
        {absoluteLines ? null : (
          <span
            className="diff-line-base"
            title="The call payload says what changed, not where — these count from the start of the hunk"
          >
            lines from hunk start
          </span>
        )}
        <CopyPathButton path={path} />
      </div>
      {parsed.hunks.map((hunk, i) => (
        <div key={i} className="diff-hunk">
          {i > 0 ? (
            <div className="diff-hunk-head">
              <span className="diff-file-path">{path}</span>
            </div>
          ) : null}
          {hunk.rows.map((row, j) => (
            <Line key={j} row={row} language={language} />
          ))}
        </div>
      ))}
      {parsed.truncated ? (
        <div className="diff-truncated">diff truncated</div>
      ) : null}
    </div>
  )
}
