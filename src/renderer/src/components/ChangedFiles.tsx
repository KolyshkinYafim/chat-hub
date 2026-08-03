import type { ChangedFiles as Changed } from "../lib/tool-runs"

function baseName(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] || path
}

export function ChangedFiles({
  changed,
  onOpenDiff,
}: {
  changed: Changed
  onOpenDiff?: (path: string) => void
}) {
  const { files, added, removed, countsKnown } = changed
  if (files.length === 0) return null
  return (
    <div className="changed-files">
      <div className="changed-head">
        <span className="changed-count">
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        {countsKnown ? (
          <>
            <span className="diff-stat add">+{added}</span>
            <span className="diff-stat del">−{removed}</span>
          </>
        ) : null}
      </div>
      <ul className="changed-list">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="changed-path"
              title={`${file.path} — open in the Diff panel`}
              onClick={() => onOpenDiff?.(file.path)}
            >
              <span className="changed-name">{baseName(file.path)}</span>
              <span className="changed-dir">{file.path}</span>
            </button>
            {typeof file.added === "number" ? (
              <span className="changed-delta">
                <span className="diff-stat add">+{file.added}</span>
                <span className="diff-stat del">−{file.removed ?? 0}</span>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
