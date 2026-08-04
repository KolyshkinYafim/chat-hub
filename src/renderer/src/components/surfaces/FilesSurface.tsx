import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { formatBytes } from "../../lib/format"
import {
  errorText,
  surfaceBridge,
  type DirEntry,
} from "../../lib/surface-bridge"
import { FileViewer } from "./FileViewer"

const ROOT = ""

type Props = {
  cwd: string
}

export function FilesSurface({ cwd }: Props) {
  const [listings, setListings] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]))
  const [pendingDirs, setPendingDirs] = useState<Set<string>>(() => new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
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
    setTreeError(null)
    void loadDir(ROOT)
  }, [loadDir])

  const onDirtyChange = useCallback((next: boolean) => {
    dirtyRef.current = next
    setDirty(next)
  }, [])

  function toggleDir(path: string) {
    setExpanded((curr) => {
      const next = new Set(curr)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!listings[path]) void loadDir(path)
  }

  function selectFile(path: string) {
    if (path === selectedPath) return
    if (dirtyRef.current && selectedPath !== null) {
      const leave = window.confirm(
        `${selectedPath} has unsaved changes. Discard them and open ${path}?`,
      )
      if (!leave) return
    }
    dirtyRef.current = false
    setDirty(false)
    setSelectedPath(path)
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
      const isSelected = selectedPath === entry.path
      const row = (
        <li key={entry.path}>
          <button
            type="button"
            className={`tree-row ${isSelected ? "active" : ""}`}
            style={{ paddingLeft: 12 + depth * 13 }}
            title={entry.path}
            onClick={() =>
              isDir ? toggleDir(entry.path) : selectFile(entry.path)
            }
          >
            <span className={`tree-twisty ${isDir ? "" : "leaf"}`}>
              {isDir ? (isOpen ? "▾" : "▸") : ""}
            </span>
            <span className={`tree-name ${isDir ? "is-dir" : ""}`}>
              {entry.name}
            </span>
            {isSelected && dirty ? <span className="tree-dirty">●</span> : null}
            {isDir ? null : (
              <span className="tree-size">{formatBytes(entry.size)}</span>
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
      {selectedPath === null ? (
        <div className="surface-viewer">
          <p className="surface-note">Select a file to read or edit it.</p>
        </div>
      ) : (
        <FileViewer
          key={selectedPath}
          cwd={cwd}
          path={selectedPath}
          onDirtyChange={onDirtyChange}
        />
      )}
    </div>
  )
}
