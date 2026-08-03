import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  errorText,
  surfaceBridge,
  type DirEntry,
  type FileContents,
} from "../../lib/surface-bridge"

const ROOT = ""

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type Props = {
  cwd: string
}

export function FilesSurface({ cwd }: Props) {
  const [listings, setListings] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]))
  const [pendingDirs, setPendingDirs] = useState<Set<string>>(() => new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [contents, setContents] = useState<FileContents | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [viewerError, setViewerError] = useState<string | null>(null)
  const liveRef = useRef(true)

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  const loadDir = useCallback(
    async (relPath: string) => {
      setPendingDirs((curr) => new Set(curr).add(relPath))
      try {
        const listing = await surfaceBridge().listDir(cwd, relPath)
        if (!liveRef.current) return
        setTreeError(null)
        setListings((curr) => ({ ...curr, [relPath]: listing.entries }))
      } catch (err) {
        if (!liveRef.current) return
        setTreeError(errorText(err))
      } finally {
        if (liveRef.current) {
          setPendingDirs((curr) => {
            const next = new Set(curr)
            next.delete(relPath)
            return next
          })
        }
      }
    },
    [cwd],
  )

  useEffect(() => {
    setListings({})
    setExpanded(new Set([ROOT]))
    setSelectedPath(null)
    setContents(null)
    setTreeError(null)
    setViewerError(null)
    void loadDir(ROOT)
  }, [loadDir])

  function toggleDir(path: string) {
    setExpanded((curr) => {
      const next = new Set(curr)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!listings[path]) void loadDir(path)
  }

  async function preview(path: string) {
    setSelectedPath(path)
    setContents(null)
    setViewerError(null)
    try {
      const file = await surfaceBridge().readFileText(cwd, path)
      if (!liveRef.current) return
      setContents(file)
    } catch (err) {
      if (!liveRef.current) return
      setViewerError(errorText(err))
    }
  }

  function renderRows(dirPath: string, depth: number): ReactNode[] {
    const entries = listings[dirPath]
    if (!entries) {
      return pendingDirs.has(dirPath)
        ? [
            <li
              key={`${dirPath}:pending`}
              className="tree-row tree-pending"
              style={{ paddingLeft: 12 + depth * 13 }}
            >
              Loading…
            </li>,
          ]
        : []
    }
    if (entries.length === 0) {
      return [
        <li
          key={`${dirPath}:empty`}
          className="tree-row tree-pending"
          style={{ paddingLeft: 12 + depth * 13 }}
        >
          Empty
        </li>,
      ]
    }
    return entries.flatMap((entry) => {
      const isDir = entry.kind === "dir"
      const isOpen = isDir && expanded.has(entry.path)
      const row = (
        <li key={entry.path}>
          <button
            type="button"
            className={`tree-row ${selectedPath === entry.path ? "active" : ""}`}
            style={{ paddingLeft: 12 + depth * 13 }}
            title={entry.path}
            onClick={() =>
              isDir ? toggleDir(entry.path) : void preview(entry.path)
            }
          >
            <span className={`tree-twisty ${isDir ? "" : "leaf"}`}>
              {isDir ? (isOpen ? "▾" : "▸") : ""}
            </span>
            <span className={`tree-name ${isDir ? "is-dir" : ""}`}>
              {entry.name}
            </span>
            {isDir ? null : (
              <span className="tree-size">{formatSize(entry.size)}</span>
            )}
          </button>
        </li>
      )
      if (!isOpen) return [row]
      return [row, ...renderRows(entry.path, depth + 1)]
    })
  }

  return (
    <div className="surface-files">
      <div className="surface-tree">
        {treeError ? <p className="surface-note error">{treeError}</p> : null}
        <ul className="tree-list">{renderRows(ROOT, 0)}</ul>
      </div>
      <div className="surface-viewer">
        {selectedPath === null ? (
          <p className="surface-note">Select a file to read it.</p>
        ) : (
          <>
            <div className="surface-viewer-head">
              <span className="mono-soft" title={selectedPath}>
                {selectedPath}
              </span>
              <span className="surface-readonly">read-only</span>
            </div>
            {viewerError ? (
              <p className="surface-note error">{viewerError}</p>
            ) : contents === null ? (
              <p className="surface-note">Reading…</p>
            ) : contents.binary ? (
              <p className="surface-note">
                Binary file — not shown as text.
              </p>
            ) : (
              <>
                {contents.truncated ? (
                  <p className="surface-note truncated">
                    Cut off at the read cap — this is not the end of the file.
                  </p>
                ) : null}
                <pre className="surface-file-body">
                  <code>{contents.text}</code>
                </pre>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
