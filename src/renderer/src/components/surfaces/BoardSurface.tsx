import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { contextHeadline } from "@shared/project-context"
import {
  boardTodoStatus,
  isBoardTodoNow,
  isBoardTodoOpen,
  withBoardTodoStatus,
  type BoardTodo,
  type BoardTodoStatus,
} from "@shared/surfaces"
import {
  surfaceBridge,
  errorText,
  type Board,
  type SurfaceKind,
} from "../../lib/surface-bridge"

/**
 * Stamp the one item the user just edited. The main-process merge resolves per
 * item: rows we merely echo back never clobber a fresher agent edit, but a row
 * carrying a `now` stamp is a deliberate change and wins. (The renderer's Board
 * mirror doesn't model `updatedAt` on items — main owns that schema — so this
 * rides along structurally.)
 */
function touch<T extends object>(item: T): T {
  return { ...item, updatedAt: Date.now() } as T
}

type Filter = "all" | "now" | "blocked" | "done"

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "now", label: "Now" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
]

const STATUS_LABEL: Record<BoardTodoStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
}

function cycleOpenStatus(status: BoardTodoStatus): BoardTodoStatus {
  if (status === "pending") return "in_progress"
  if (status === "in_progress") return "blocked"
  return "pending"
}

function haystack(todo: BoardTodo): string {
  return [todo.text, todo.blockedReason, todo.result]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

function matchesFilter(todo: BoardTodo, filter: Filter): boolean {
  const status = boardTodoStatus(todo)
  if (filter === "now") return isBoardTodoNow(todo)
  if (filter === "blocked") return status === "blocked"
  if (filter === "done") return status === "done"
  return true
}

type Props = {
  cwd: string
  /** Present in the dock; lets the strip hand off to the context surface. */
  onOpenSurface?: (kind: SurfaceKind) => void
}

export function BoardSurface({ cwd, onOpenSurface }: Props) {
  const [board, setBoard] = useState<Board>({ todos: [], notes: [] })
  const [head, setHead] = useState<{ line: string; share: boolean } | null>(null)
  const [todoDraft, setTodoDraft] = useState("")
  const [noteDraft, setNoteDraft] = useState("")
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [blockerDrafts, setBlockerDrafts] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)
  // Last-seen persisted stamp: lets the poll ignore what we ourselves just wrote.
  const updatedRef = useRef(0)
  const bridge = surfaceBridge()

  const adopt = useCallback((b: Board) => {
    updatedRef.current = b.updatedAt ?? 0
    setBoard(b)
  }, [])

  useEffect(() => {
    let alive = true
    void bridge
      .boardRead(cwd)
      .then((b) => alive && adopt(b))
      .catch((e) => alive && setErr(errorText(e)))
    // Poll for the agent's own edits to the file (last-writer-wins, ~1.5s).
    const timer = setInterval(() => {
      void bridge
        .boardRead(cwd)
        .then((b) => {
          // Only ever move FORWARD: an in-flight read that started before our own
          // optimistic write would otherwise resolve with the pre-write board and
          // regress the UI (dropping the just-added item). `>` ignores those.
          if (alive && (b.updatedAt ?? 0) > updatedRef.current) adopt(b)
        })
        .catch(() => undefined)
    }, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [cwd, bridge, adopt])

  // The other half of the same folder: one line of `.chathub/context/overview.md`
  // so the board says which project it belongs to, and whether the agent is
  // being told about it. Read once — context changes far slower than todos.
  useEffect(() => {
    let alive = true
    void bridge
      .contextRead(cwd)
      .then((ctx) => {
        if (!alive || !ctx.seeded) return
        const overview = ctx.docs.find((d) => d.id === "overview")
        setHead({
          line: contextHeadline(overview?.text ?? ""),
          share: ctx.share,
        })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [cwd, bridge])

  const persist = useCallback(
    (next: Board) => {
      setBoard(next)
      void bridge
        .boardWrite(cwd, next)
        .then(adopt)
        .catch((e) => setErr(errorText(e)))
    },
    [cwd, bridge, adopt],
  )

  const patchTodo = useCallback(
    (id: string, fn: (todo: BoardTodo) => BoardTodo) => {
      persist({
        ...board,
        todos: board.todos.map((todo) =>
          todo.id === id ? touch(fn(todo)) : todo,
        ),
      })
    },
    [board, persist],
  )

  function addTodo() {
    const text = todoDraft.trim()
    if (!text) return
    setTodoDraft("")
    persist({
      ...board,
      todos: [
        ...board.todos,
        {
          id: crypto.randomUUID(),
          text,
          done: false,
          status: "pending",
          source: "user",
          createdAt: Date.now(),
        },
      ],
    })
  }

  function addNote() {
    const text = noteDraft.trim()
    if (!text) return
    setNoteDraft("")
    persist({
      ...board,
      notes: [
        ...board.notes,
        { id: crypto.randomUUID(), text, createdAt: Date.now() },
      ],
    })
  }

  const onEnter = (e: KeyboardEvent, fn: () => void) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      fn()
    }
  }

  const counts = useMemo(() => {
    let open = 0
    let now = 0
    let blocked = 0
    let done = 0
    for (const todo of board.todos) {
      const status = boardTodoStatus(todo)
      if (isBoardTodoOpen(todo)) open += 1
      if (isBoardTodoNow(todo)) now += 1
      if (status === "blocked") blocked += 1
      if (status === "done") done += 1
    }
    return { open, now, blocked, done, total: board.todos.length }
  }, [board.todos])

  const visibleTodos = useMemo(() => {
    const q = query.trim().toLowerCase()
    return board.todos.filter((todo) => {
      if (!matchesFilter(todo, filter)) return false
      if (q && !haystack(todo).includes(q)) return false
      return true
    })
  }, [board.todos, filter, query])

  const notes = [...board.notes].sort((a, b) => b.createdAt - a.createdAt)

  const nowLine =
    counts.total === 0
      ? "No tasks yet"
      : [
          counts.now ? `${counts.now} in work` : `${counts.open} open`,
          counts.blocked ? `${counts.blocked} blocked` : null,
          `${counts.done}/${counts.total} done`,
        ]
          .filter(Boolean)
          .join(" · ")

  return (
    <div className="board-surface">
      {err ? <div className="board-error">{err}</div> : null}

      <button
        type="button"
        className="board-context"
        title="Project context — overview, stack, conventions, current focus"
        onClick={() => onOpenSurface?.("context")}
      >
        <span className="board-context-line">
          {head?.line || "Context — what this project is and what we are doing"}
        </span>
        {head?.share ? (
          <span className="board-context-share">sent to the agent</span>
        ) : null}
      </button>

      <section className="board-section">
        <div className="board-section-head">
          <h3>Todos</h3>
          <span className="board-count">{nowLine}</span>
        </div>

        <div className="board-toolbar">
          <div className="board-filters" role="tablist" aria-label="Task filter">
            {FILTERS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                role="tab"
                aria-selected={filter === chip.id}
                className={`board-filter ${filter === chip.id ? "on" : ""}`}
                onClick={() => setFilter(chip.id)}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <input
            className="board-search"
            value={query}
            placeholder="Find a task…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find a task"
          />
        </div>

        <div className="board-add">
          <input
            value={todoDraft}
            placeholder="Add a task…"
            onChange={(e) => setTodoDraft(e.target.value)}
            onKeyDown={(e) => onEnter(e, addTodo)}
          />
          <button type="button" onClick={addTodo} title="Add task">
            +
          </button>
        </div>
        <ul className="board-todos">
          {visibleTodos.map((t) => {
            const status = boardTodoStatus(t)
            return (
              <li
                key={t.id}
                className={`board-todo status-${status} ${status === "done" ? "done" : ""}`}
              >
                <button
                  type="button"
                  className="board-check"
                  aria-pressed={status === "done"}
                  title={status === "done" ? "Mark open" : "Mark done"}
                  onClick={() =>
                    patchTodo(t.id, (todo) =>
                      withBoardTodoStatus(
                        todo,
                        boardTodoStatus(todo) === "done" ? "pending" : "done",
                      ),
                    )
                  }
                >
                  {status === "done" ? "✓" : ""}
                </button>
                <button
                  type="button"
                  className="board-status"
                  title={`${STATUS_LABEL[status]} — click to cycle`}
                  disabled={status === "done" || status === "cancelled"}
                  onClick={() =>
                    patchTodo(t.id, (todo) => {
                      const cur = boardTodoStatus(todo)
                      if (cur === "done" || cur === "cancelled") return todo
                      return withBoardTodoStatus(todo, cycleOpenStatus(cur))
                    })
                  }
                >
                  <span className="board-status-dot" aria-hidden />
                  <span className="board-status-label">
                    {STATUS_LABEL[status]}
                  </span>
                </button>
                <div className="board-todo-body">
                  <span className="board-todo-text">{t.text}</span>
                  {t.source === "plan" ? (
                    <span className="board-source">plan</span>
                  ) : null}
                  {status === "blocked" ? (
                    <input
                      className="board-blocker"
                      value={blockerDrafts[t.id] ?? t.blockedReason ?? ""}
                      placeholder="What’s blocking this?"
                      aria-label="Blocker"
                      onChange={(e) => {
                        const value = e.target.value
                        setBlockerDrafts((drafts) => ({
                          ...drafts,
                          [t.id]: value,
                        }))
                      }}
                      onBlur={() => {
                        const blockedReason = (
                          blockerDrafts[t.id] ??
                          t.blockedReason ??
                          ""
                        ).trim()
                        setBlockerDrafts((drafts) => {
                          const next = { ...drafts }
                          delete next[t.id]
                          return next
                        })
                        patchTodo(t.id, (todo) => ({
                          ...todo,
                          blockedReason: blockedReason || undefined,
                        }))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur()
                      }}
                    />
                  ) : t.blockedReason ? (
                    <span className="board-todo-meta blocked">
                      {t.blockedReason}
                    </span>
                  ) : null}
                  {t.result ? (
                    <span className="board-todo-meta result">{t.result}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="board-del"
                  title="Delete"
                  onClick={() =>
                    persist({
                      ...board,
                      todos: board.todos.filter((x) => x.id !== t.id),
                    })
                  }
                >
                  ×
                </button>
              </li>
            )
          })}
          {board.todos.length === 0 ? (
            <li className="board-empty">
              No todos yet — add one, or the agent will mirror its checklist
              here.
            </li>
          ) : visibleTodos.length === 0 ? (
            <li className="board-empty">
              {query ? (
                <>
                  Nothing matches <b>{query}</b> in this filter.
                </>
              ) : (
                "No tasks match this filter."
              )}
            </li>
          ) : null}
        </ul>
      </section>

      <section className="board-section">
        <div className="board-section-head">
          <h3>Notes</h3>
          <span className="board-count">
            {notes.length === 0
              ? "what the agent decided and why"
              : `${notes.length} note${notes.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="board-add">
          <input
            value={noteDraft}
            placeholder="Add a note…"
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => onEnter(e, addNote)}
          />
          <button type="button" onClick={addNote} title="Add note">
            +
          </button>
        </div>
        <ul className="board-notes">
          {notes.map((n) => (
            <li key={n.id} className="board-note">
              <span className="board-note-text">{n.text}</span>
              <button
                type="button"
                className="board-del"
                title="Delete"
                onClick={() =>
                  persist({
                    ...board,
                    notes: board.notes.filter((x) => x.id !== n.id),
                  })
                }
              >
                ×
              </button>
            </li>
          ))}
          {notes.length === 0 ? (
            <li className="board-empty">
              No notes yet — the agent can add them by editing
              <code> .chathub/board.json</code>.
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  )
}
