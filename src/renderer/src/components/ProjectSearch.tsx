import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { fuzzyScore } from "../lib/fuzzy"
import {
  errorText,
  surfaceBridge,
  type ProjectSearchHit,
} from "../lib/surface-bridge"

export type ProjectSearchMode = "files" | "content"

type Props = {
  cwd: string
  mode: ProjectSearchMode
  onModeChange: (mode: ProjectSearchMode) => void
  onOpenFile: (path: string, line?: number) => void
  onClose: () => void
}

const CONTENT_DEBOUNCE_MS = 250
const MIN_CONTENT_QUERY = 2
const FILE_ROW_LIMIT = 50

const fileListCache = new Map<string, string[]>()

function basenameOf(path: string): string {
  const at = path.lastIndexOf("/")
  return at === -1 ? path : path.slice(at + 1)
}

function dirnameOf(path: string): string {
  const at = path.lastIndexOf("/")
  return at === -1 ? "" : path.slice(0, at)
}

function highlightMatch(text: string, query: string): ReactNode {
  const q = query.trim()
  if (q.length === 0) return text
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  if (at === -1) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className="psearch-mark">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  )
}

/** ⌘P / ⇧⌘F overlay: fuzzy file picker and project-wide content search. */
export function ProjectSearch({
  cwd,
  mode,
  onModeChange,
  onOpenFile,
  onClose,
}: Props) {
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const [files, setFiles] = useState<string[] | null>(
    () => fileListCache.get(cwd) ?? null,
  )
  const [filesError, setFilesError] = useState<string | null>(null)
  const [hits, setHits] = useState<ProjectSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const searchSeq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    void surfaceBridge()
      .projectFiles(cwd)
      .then((list) => {
        fileListCache.set(cwd, list)
        if (!live) return
        setFiles(list)
        setFilesError(null)
      })
      .catch((err) => {
        if (live && !fileListCache.has(cwd)) setFilesError(errorText(err))
      })
    return () => {
      live = false
    }
  }, [cwd])

  useEffect(() => {
    if (mode !== "content") return
    const q = query.trim()
    const seq = ++searchSeq.current
    if (q.length < MIN_CONTENT_QUERY) {
      setHits([])
      setSearching(false)
      setSearchError(null)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => {
      void surfaceBridge()
        .projectSearch(cwd, q)
        .then((found) => {
          if (searchSeq.current !== seq) return
          setHits(found)
          setSearchError(null)
          setSearching(false)
        })
        .catch((err) => {
          if (searchSeq.current !== seq) return
          setSearchError(errorText(err))
          setSearching(false)
        })
    }, CONTENT_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [cwd, mode, query])

  useEffect(() => {
    setCursor(0)
    inputRef.current?.focus()
  }, [mode])

  const fileResults = useMemo(() => {
    if (mode !== "files" || files === null) return []
    const scored: { path: string; score: number }[] = []
    for (const path of files) {
      const score = fuzzyScore(query, path)
      if (score !== null) scored.push({ path, score })
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : 1),
    )
    return scored.slice(0, FILE_ROW_LIMIT).map((r) => r.path)
  }, [files, mode, query])

  const rowCount = mode === "files" ? fileResults.length : hits.length
  const clamped = Math.min(cursor, Math.max(rowCount - 1, 0))

  function pick(index: number) {
    if (mode === "files") {
      const path = fileResults[index]
      if (!path) return
      onOpenFile(path)
    } else {
      const hit = hits[index]
      if (!hit) return
      onOpenFile(hit.path, hit.line)
    }
    onClose()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setCursor(Math.min(clamped + 1, Math.max(rowCount - 1, 0)))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setCursor(Math.max(clamped - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      pick(clamped)
    } else if (e.key === "Escape") {
      e.preventDefault()
      onClose()
    }
  }

  function emptyText(): string {
    if (mode === "files") {
      if (filesError) return filesError
      if (files === null) return "Indexing project files…"
      return "No file matches"
    }
    if (searchError) return searchError
    if (query.trim().length < MIN_CONTENT_QUERY) {
      return "Type at least two characters to search file contents."
    }
    return searching ? "Searching…" : "No matches in the project"
  }

  function renderFileRows(): ReactNode {
    return fileResults.map((path, i) => (
      <button
        key={path}
        type="button"
        role="option"
        aria-selected={i === clamped}
        className={`psearch-row ${i === clamped ? "on" : ""}`}
        onMouseEnter={() => setCursor(i)}
        onClick={() => pick(i)}
      >
        <span className="psearch-name">{basenameOf(path)}</span>
        <span className="psearch-dir mono-soft">{dirnameOf(path)}</span>
      </button>
    ))
  }

  function renderContentRows(): ReactNode {
    const rows: ReactNode[] = []
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i]
      if (i === 0 || hits[i - 1].path !== hit.path) {
        rows.push(
          <div key={`head:${hit.path}:${i}`} className="psearch-file-head">
            <span className="psearch-name">{basenameOf(hit.path)}</span>
            <span className="psearch-dir mono-soft">{dirnameOf(hit.path)}</span>
          </div>,
        )
      }
      rows.push(
        <button
          key={`${hit.path}:${hit.line}:${i}`}
          type="button"
          role="option"
          aria-selected={i === clamped}
          className={`psearch-row psearch-hit ${i === clamped ? "on" : ""}`}
          onMouseEnter={() => setCursor(i)}
          onClick={() => pick(i)}
        >
          <span className="psearch-line-no mono-soft">{hit.line}</span>
          <span className="psearch-excerpt mono-soft">
            {highlightMatch(hit.text, query)}
          </span>
        </button>,
      )
    }
    return rows
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal-panel palette-panel psearch-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Project search"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="psearch-head">
          <input
            ref={inputRef}
            className="palette-input psearch-input"
            value={query}
            autoFocus
            placeholder={
              mode === "files"
                ? "Go to file…"
                : "Search file contents… (2+ characters)"
            }
            aria-label={
              mode === "files" ? "Go to file" : "Search file contents"
            }
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            onKeyDown={onKeyDown}
          />
          <div className="psearch-modes" role="tablist" aria-label="Search mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "files"}
              className={`psearch-mode ${mode === "files" ? "on" : ""}`}
              title="Go to file (⌘P)"
              onClick={() => onModeChange("files")}
            >
              Files
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "content"}
              className={`psearch-mode ${mode === "content" ? "on" : ""}`}
              title="Search file contents (⇧⌘F)"
              onClick={() => onModeChange("content")}
            >
              Text
            </button>
          </div>
        </div>
        <div className="palette-list psearch-list" role="listbox">
          {rowCount === 0 ? (
            (mode === "files" && !filesError && files === null) ||
            (mode === "content" && !searchError && searching) ? (
              <div className="palette-loading" aria-label={emptyText()}>
                <span className="skel-line" />
                <span className="skel-line" />
                <span className="skel-line" />
              </div>
            ) : (
              <div className="palette-empty">{emptyText()}</div>
            )
          ) : mode === "files" ? (
            renderFileRows()
          ) : (
            renderContentRows()
          )}
        </div>
        <div className="palette-foot">
          <span className="kbd">↑↓</span> move
          <span className="kbd">↩</span> open
          <span className="kbd">esc</span> close
        </div>
      </div>
    </div>
  )
}
