import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { formatBytes } from "../../lib/format"
import {
  errorText,
  surfaceBridge,
  type DirEntry,
} from "../../lib/surface-bridge"
import { FileViewer } from "./FileViewer"

const ROOT = ""

type NewEntryKind = "file" | "dir"

function parentOf(path: string): string {
  const at = path.lastIndexOf("/")
  return at === -1 ? ROOT : path.slice(0, at)
}

function childOf(dir: string, name: string): string {
  return dir === ROOT ? name : `${dir}/${name}`
}

export type FilesFocus = {
  path: string
  line: number | null
  /** Expand `path` as a folder instead of opening it as a file. */
  directory?: boolean
  at: number
}

type Props = {
  cwd: string
  focus?: FilesFocus | null
}

export function FilesSurface({ cwd, focus = null }: Props) {
  const [listings, setListings] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]))
  const [pendingDirs, setPendingDirs] = useState<Set<string>>(() => new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  /** Where "New file"/"New folder" will land: the last folder or file touched. */
  const [activeDir, setActiveDir] = useState<string>(ROOT)
  const [creating, setCreating] = useState<NewEntryKind | null>(null)
  const [newName, setNewName] = useState("")
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const liveRef = useRef(true)
  const newNameRef = useRef<HTMLInputElement>(null)

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
    setActiveDir(ROOT)
    setCreating(null)
    setCreateError(null)
    void loadDir(ROOT)
  }, [loadDir])

  useEffect(() => {
    if (creating !== null) newNameRef.current?.focus()
  }, [creating])

  const onDirtyChange = useCallback((next: boolean) => {
    dirtyRef.current = next
    setDirty(next)
  }, [])

  useEffect(() => {
    if (!focus) return
    const ancestors: string[] = []
    for (let dir = parentOf(focus.path); dir !== ROOT; dir = parentOf(dir)) {
      ancestors.unshift(dir)
    }
    const open = focus.directory === true ? [...ancestors, focus.path] : ancestors
    setExpanded((curr) => {
      const next = new Set(curr)
      for (const dir of open) next.add(dir)
      return next
    })
    for (const dir of open) {
      if (!listings[dir]) void loadDir(dir)
    }
    if (focus.directory === true) setActiveDir(focus.path)
    else selectFile(focus.path)
  }, [focus?.at])

  function toggleDir(path: string) {
    setActiveDir(path)
    setExpanded((curr) => {
      const next = new Set(curr)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!listings[path]) void loadDir(path)
  }

  function selectFile(path: string) {
    setActiveDir(parentOf(path))
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

  function startCreating(kind: NewEntryKind) {
    setCreating(kind)
    setNewName("")
    setCreateError(null)
  }

  function cancelCreating() {
    setCreating(null)
    setNewName("")
    setCreateError(null)
  }

  async function submitCreating() {
    const name = newName.trim()
    if (creating === null || name === "" || createBusy) return
    const target = childOf(activeDir, name)
    const parent = parentOf(target)
    setCreateBusy(true)
    setCreateError(null)
    try {
      if (creating === "dir") {
        await surfaceBridge().createDirectory(cwd, target)
      } else {
        await surfaceBridge().createFile(cwd, target)
      }
      if (!liveRef.current) return
      setExpanded((curr) => {
        const next = new Set(curr).add(parent)
        if (creating === "dir") next.add(target)
        return next
      })
      await loadDir(parent)
      if (creating === "dir") await loadDir(target)
      if (!liveRef.current) return
      if (creating === "file") selectFile(target)
      else setActiveDir(target)
      setCreating(null)
      setNewName("")
    } catch (err) {
      if (liveRef.current) setCreateError(errorText(err))
    } finally {
      if (liveRef.current) setCreateBusy(false)
    }
  }

  function onNewNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault()
      void submitCreating()
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      cancelCreating()
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

  const targetLabel = activeDir === ROOT ? "/" : `${activeDir}/`

  return (
    <div className="surface-files">
      <div className="surface-tree-head">
        <span className="tree-head-target" title={targetLabel}>
          {targetLabel}
        </span>
        {creating === null ? (
          <>
            <button
              type="button"
              className="file-action"
              onClick={() => startCreating("file")}
            >
              New file
            </button>
            <button
              type="button"
              className="file-action"
              onClick={() => startCreating("dir")}
            >
              New folder
            </button>
          </>
        ) : (
          <>
            <input
              ref={newNameRef}
              className="tree-new-name"
              value={newName}
              disabled={createBusy}
              placeholder={creating === "dir" ? "folder name" : "file name"}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={onNewNameKeyDown}
            />
            <button
              type="button"
              className="file-action"
              disabled={createBusy || newName.trim() === ""}
              onClick={() => void submitCreating()}
            >
              {createBusy ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              className="file-action"
              disabled={createBusy}
              onClick={cancelCreating}
            >
              Cancel
            </button>
          </>
        )}
      </div>
      {createError ? (
        <p className="surface-note error">{createError}</p>
      ) : null}
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
          focus={
            focus && focus.path === selectedPath && focus.line !== null
              ? { line: focus.line, at: focus.at }
              : null
          }
          onDirtyChange={onDirtyChange}
        />
      )}
    </div>
  )
}
