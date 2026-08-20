import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import {
  CONTEXT_DIR_REL,
  CONTEXT_DOCS,
  buildContextBrief,
  estimateContextTokens,
  type ContextDocId,
} from "@shared/project-context"
import { isBoardTodoOpen } from "@shared/surfaces"
import {
  surfaceBridge,
  errorText,
  type ProjectContext,
  type SurfaceKind,
} from "../../lib/surface-bridge"

/**
 * Per-project context: four markdown files under `.chathub/context/`, plus the
 * switch that decides whether they ride along on every turn. The agent edits
 * those files like any other file in the workspace, so we poll the way the board
 * does and keep the owner's unsaved drafts on top of whatever arrives.
 */

const POLL_MS = 2000

type Props = {
  cwd: string
  /** Lets the focus document hand off to the board, its other half. */
  onOpenSurface?: (kind: SurfaceKind) => void
}

type Drafts = Partial<Record<ContextDocId, string>>

export function ContextSurface({ cwd, onOpenSurface }: Props) {
  const [ctx, setCtx] = useState<ProjectContext | null>(null)
  const [openTodos, setOpenTodos] = useState<string[]>([])
  const [active, setActive] = useState<ContextDocId>("overview")
  const [drafts, setDrafts] = useState<Drafts>({})
  const [preview, setPreview] = useState(false)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Last-seen persisted stamp: lets the poll ignore what we ourselves just wrote.
  const updatedRef = useRef(0)
  // What each draft was started from, so a save that would silently discard an
  // agent's edit to the same file can say so first.
  const baseRef = useRef<Drafts>({})
  const bridge = surfaceBridge()

  const adopt = useCallback((next: ProjectContext) => {
    updatedRef.current = next.updatedAt
    setCtx(next)
  }, [])

  useEffect(() => {
    let alive = true
    const readTodos = () =>
      bridge
        .boardRead(cwd)
        .then((board) => {
          if (!alive) return
          setOpenTodos(
            board.todos.filter((t) => isBoardTodoOpen(t)).map((t) => t.text),
          )
        })
        .catch(() => undefined)

    void bridge
      .contextRead(cwd)
      .then((next) => alive && adopt(next))
      .catch((e) => alive && setErr(errorText(e)))
    void readTodos()

    const timer = setInterval(() => {
      void bridge
        .contextRead(cwd)
        .then((next) => {
          // Only ever move forward, so a read that started before our own write
          // cannot resolve later and put the pre-write text back on screen.
          if (alive && next.updatedAt > updatedRef.current) adopt(next)
        })
        .catch(() => undefined)
      void readTodos()
    }, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [cwd, bridge, adopt])

  const run = useCallback(
    (work: Promise<ProjectContext>, clear?: ContextDocId) => {
      setBusy(true)
      setErr(null)
      void work
        .then((next) => {
          adopt(next)
          if (clear === undefined) return
          setDrafts((current) => {
            const remaining = { ...current }
            delete remaining[clear]
            return remaining
          })
        })
        .catch((e) => setErr(errorText(e)))
        .finally(() => setBusy(false))
    },
    [adopt],
  )

  const docs = useMemo(() => ctx?.docs ?? [], [ctx])
  const doc = docs.find((d) => d.id === active)
  const spec = CONTEXT_DOCS.find((s) => s.id === active)
  const seeded = ctx?.seeded ?? false
  const text = drafts[active] ?? doc?.text ?? ""
  const dirty = drafts[active] !== undefined && drafts[active] !== doc?.text
  const conflict = dirty && baseRef.current[active] !== doc?.text

  // What the agent gets is the file on disk, never the unsaved draft — so the
  // preview and the token count are built from `ctx`, not from the textarea.
  const brief = useMemo(
    () => (seeded ? buildContextBrief(docs, openTodos) : ""),
    [seeded, docs, openTodos],
  )
  const tokens = estimateContextTokens(brief)
  const share = ctx?.share ?? false
  const unsaved = Object.entries(drafts).filter(
    ([id, value]) => value !== docs.find((d) => d.id === id)?.text,
  )

  function save() {
    const pending = drafts[active]
    if (pending === undefined) return
    run(bridge.contextWriteDoc(cwd, active, pending), active)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault()
      save()
    }
  }

  if (!ctx) {
    return (
      <div className="context-surface">
        {err ? <div className="board-error">{err}</div> : null}
        {err ? null : <p className="surface-note">Reading project context…</p>}
      </div>
    )
  }

  return (
    <div className="context-surface">
      {err ? <div className="board-error">{err}</div> : null}

      <div className="ctx-head">
        <label
          className="switch"
          title={
            seeded
              ? "Append this context to every turn's system prompt"
              : "Create the files first"
          }
        >
          <input
            type="checkbox"
            checked={share && seeded}
            disabled={!seeded || busy}
            onChange={(e) => run(bridge.contextSetShare(cwd, e.target.checked))}
          />
          <span className="switch-track" />
        </label>
        <div className="ctx-head-text">
          <span className="ctx-head-title">Send to the agent</span>
          <span className="ctx-head-cost">
            {!seeded
              ? "nothing to send yet"
              : share
                ? `~${tokens} tokens on every turn`
                : "off — the prompt is untouched"}
          </span>
        </div>
        <button
          type="button"
          className="ctx-preview-toggle"
          aria-pressed={preview}
          disabled={!seeded}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Edit" : "Preview"}
        </button>
      </div>

      {!seeded ? (
        <div className="ctx-seed">
          <p>
            No <code>{CONTEXT_DIR_REL}/</code> yet. The draft below was read off
            this repo — package.json, the lockfile, the git remote and the
            top-level folders. Create it, then correct what is wrong.
          </p>
          <button
            type="button"
            className="ctx-seed-create"
            disabled={busy}
            onClick={() => run(bridge.contextSeed(cwd))}
          >
            Create context files
          </button>
        </div>
      ) : null}

      <div className="ctx-tabs" role="tablist">
        {CONTEXT_DOCS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className={`ctx-tab ${active === tab.id ? "active" : ""}`}
            aria-selected={active === tab.id}
            onClick={() => {
              setActive(tab.id)
              setArmed(false)
            }}
          >
            {tab.label}
            {unsaved.some(([id]) => id === tab.id) ? (
              <span className="ctx-dot" title="Unsaved edits" />
            ) : null}
          </button>
        ))}
      </div>

      {preview ? (
        <div className="ctx-preview">
          <p className="ctx-preview-note">
            Appended to the system prompt every turn, exactly as written here.
            {unsaved.length > 0 ? " Unsaved edits are not part of it yet." : ""}
          </p>
          <pre className="ctx-preview-body">{brief || "(nothing to send)"}</pre>
        </div>
      ) : (
        <div className="ctx-doc">
          <div className="ctx-doc-head">
            <span className={`ctx-doc-hint ${conflict ? "warn" : ""}`}>
              {conflict
                ? "Changed on disk while you were editing — saving replaces it."
                : spec?.hint}
            </span>
            {active === "stack" && seeded ? (
              <button
                type="button"
                className="ctx-redetect"
                disabled={busy}
                title="Re-read the repo and overwrite stack.md"
                onClick={() => {
                  if (!armed) {
                    setArmed(true)
                    return
                  }
                  setArmed(false)
                  setDrafts((current) => {
                    const remaining = { ...current }
                    delete remaining.stack
                    return remaining
                  })
                  run(bridge.contextSeed(cwd, "stack"))
                }}
              >
                {armed ? "Overwrite stack.md?" : "Re-detect"}
              </button>
            ) : null}
          </div>
          <textarea
            className="ctx-editor"
            value={text}
            readOnly={!seeded}
            spellCheck={false}
            placeholder={`Write ${spec?.file} in markdown…`}
            onChange={(e) => {
              if (drafts[active] === undefined) {
                baseRef.current = { ...baseRef.current, [active]: doc?.text ?? "" }
              }
              setDrafts({ ...drafts, [active]: e.target.value })
            }}
            onKeyDown={onKeyDown}
          />
          <div className="ctx-doc-foot">
            <code className="ctx-path">
              {CONTEXT_DIR_REL}/{spec?.file}
            </code>
            <button
              type="button"
              className="ctx-save"
              disabled={!dirty || busy || !seeded}
              onClick={save}
            >
              {dirty ? "Save" : "Saved"}
            </button>
          </div>
        </div>
      )}

      {active === "focus" && !preview ? (
        <section className="ctx-todos">
          <div className="ctx-todos-head">
            <h3>Open todos</h3>
            <button type="button" onClick={() => onOpenSurface?.("board")}>
              Board
            </button>
          </div>
          <ul>
            {openTodos.slice(0, 8).map((todo) => (
              <li key={todo}>{todo}</li>
            ))}
            {openTodos.length === 0 ? (
              <li className="board-empty">Nothing open on the board.</li>
            ) : null}
          </ul>
          <p className="ctx-todos-note">
            The board's open todos are sent with this document — one answer to
            &ldquo;what are we doing right now&rdquo;, not two.
          </p>
        </section>
      ) : null}
    </div>
  )
}
