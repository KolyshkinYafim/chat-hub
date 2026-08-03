import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { surfaceBridge, errorText, type Board } from "../../lib/surface-bridge"

/**
 * Per-project board: todos + the agent's running notes, persisted at
 * `.chathub/board.json`. The agent edits that file directly during a turn; we
 * poll so those out-of-band edits show up live, and the user can edit too.
 */
export function BoardSurface({ cwd }: { cwd: string }) {
  const [board, setBoard] = useState<Board>({ todos: [], notes: [] })
  const [todoDraft, setTodoDraft] = useState("")
  const [noteDraft, setNoteDraft] = useState("")
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
          if (alive && (b.updatedAt ?? 0) !== updatedRef.current) adopt(b)
        })
        .catch(() => undefined)
    }, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [cwd, bridge, adopt])

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

  function addTodo() {
    const text = todoDraft.trim()
    if (!text) return
    setTodoDraft("")
    persist({
      ...board,
      todos: [
        ...board.todos,
        { id: crypto.randomUUID(), text, done: false, createdAt: Date.now() },
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

  const openCount = board.todos.filter((t) => !t.done).length
  const doneCount = board.todos.length - openCount
  const notes = [...board.notes].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="board-surface">
      {err ? <div className="board-error">{err}</div> : null}

      <section className="board-section">
        <div className="board-section-head">
          <h3>Todos</h3>
          <span className="board-count">
            {doneCount}/{board.todos.length} done
          </span>
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
          {board.todos.map((t) => (
            <li key={t.id} className={`board-todo ${t.done ? "done" : ""}`}>
              <button
                type="button"
                className="board-check"
                aria-pressed={t.done}
                title={t.done ? "Mark open" : "Mark done"}
                onClick={() =>
                  persist({
                    ...board,
                    todos: board.todos.map((x) =>
                      x.id === t.id ? { ...x, done: !x.done } : x,
                    ),
                  })
                }
              >
                {t.done ? "✓" : ""}
              </button>
              <span className="board-todo-text">{t.text}</span>
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
          ))}
          {board.todos.length === 0 ? (
            <li className="board-empty">No todos yet.</li>
          ) : null}
        </ul>
      </section>

      <section className="board-section">
        <div className="board-section-head">
          <h3>Notes</h3>
          <span className="board-count">{notes.length}</span>
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
