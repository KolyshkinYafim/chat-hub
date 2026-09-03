import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import {
  SURFACE_OPS,
  emptySurfaceState,
  type SurfaceOpenRequest,
  type SurfaceRequest,
  type SurfaceResponse,
  type SurfaceStateReport,
} from "@shared/surface-control"
import {
  SURFACE_KINDS,
  SURFACE_LABEL,
  isSurfaceKind,
  type Board,
  type BoardTodo,
  type SurfaceKind,
} from "@shared/surfaces"
import type { ProjectScript } from "@shared/scripts"
import { readBoard, writeBoard } from "./board"
import { readScripts } from "./scripts"
import { resolveContainedPath } from "./paths"

/** Only the session fields the dock tools need; `SessionMeta` satisfies it. */
export type SurfaceSession = { id: string; title: string; cwd: string }

export type SurfaceControlDeps = {
  session: (sessionId: string) => SurfaceSession | null
  /** One line in that session's transcript, so a moved panel is never mute. */
  note: (sessionId: string, text: string) => void
  open: (request: SurfaceOpenRequest) => void
}

const UNKNOWN_SESSION =
  "This session is not open in Chat Hub, so its panels cannot be driven."

const PATH_SURFACES = new Set<SurfaceKind>(["diff", "files", "design"])

const KIND_LIST = SURFACE_KINDS.join(", ")

type Target = {
  surface: SurfaceKind
  path: string | null
  directory: boolean
  line: number | null
  command: string | null
}

/** What a todo lookup found: exactly one row, several, or none. */
export type TodoMatch =
  | { kind: "one"; todo: BoardTodo }
  | { kind: "many"; todos: BoardTodo[] }
  | { kind: "none" }

/**
 * Find the todo a tool call meant. Ids are exact; text is matched exactly
 * first (case-insensitively), then as a substring, so an agent that quotes a
 * todo back verbatim always lands even when a shorter row contains it.
 */
export function matchBoardTodo(todos: BoardTodo[], needle: string): TodoMatch {
  const wanted = needle.trim().toLowerCase()
  if (wanted === "") return { kind: "none" }
  const byId = todos.filter((t) => t.id.toLowerCase() === wanted)
  if (byId.length === 1) return { kind: "one", todo: byId[0] }
  const exact = todos.filter((t) => t.text.trim().toLowerCase() === wanted)
  if (exact.length === 1) return { kind: "one", todo: exact[0] }
  if (exact.length > 1) return { kind: "many", todos: exact }
  const loose = todos.filter((t) => t.text.toLowerCase().includes(wanted))
  if (loose.length === 1) return { kind: "one", todo: loose[0] }
  if (loose.length > 1) return { kind: "many", todos: loose }
  return { kind: "none" }
}

export function describeDockState(
  session: SurfaceSession,
  state: SurfaceStateReport,
): string {
  const mine = state.surfaceBySession[session.id]
  const panel = mine ? SURFACE_LABEL[mine] : null
  const onScreen = state.activeSessionId === session.id
  if (onScreen) {
    const where = state.dockOpen
      ? panel
        ? `The dock is open on ${panel}.`
        : "The dock is open on the surface chooser."
      : panel
        ? `The dock is closed; it would reopen on ${panel}.`
        : "The dock is closed and no surface is chosen for it."
    return `This session is on screen. ${where}\nSurfaces: ${KIND_LIST}.`
  }
  const showing = state.activeSessionId
    ? `Chat Hub is showing another session`
    : "No session is on screen"
  const setting = panel
    ? `This session's panel is set to ${panel}.`
    : "This session has no panel chosen yet."
  return `${showing}, so opening a surface here changes nothing on screen. ${setting}\nSurfaces: ${KIND_LIST}.`
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function quote(value: string): string {
  return JSON.stringify(value)
}

function countTodos(todos: BoardTodo[]): string {
  const done = todos.filter((t) => t.done).length
  return `${todos.length - done} open, ${done} done`
}

function listTodos(todos: BoardTodo[], limit = 8): string {
  const shown = todos.slice(0, limit).map((t) => `- ${t.text}`)
  if (todos.length > limit) shown.push(`- … ${todos.length - limit} more`)
  return shown.join("\n")
}

function scriptNames(scripts: ProjectScript[]): string {
  return scripts.map((s) => s.name).join(", ")
}

function findScript(
  scripts: ProjectScript[],
  wanted: string,
): ProjectScript | null {
  const needle = wanted.trim().toLowerCase()
  return (
    scripts.find((s) => s.id === wanted) ??
    scripts.find((s) => s.name.trim().toLowerCase() === needle) ??
    null
  )
}

function where(path: string | null, line: number | null): string {
  if (!path) return ""
  return line === null ? ` on ${path}` : ` on ${path}:${line}`
}

/**
 * The dock half of the agent's tools: it decides what a call is allowed to do,
 * tells the renderer, and writes the trace. It never raises, focuses or resizes
 * the app window — a tool call may change what a panel shows, never where the
 * user's hands are.
 */
export class SurfaceControl {
  private state: SurfaceStateReport = emptySurfaceState()

  constructor(private readonly deps: SurfaceControlDeps) {}

  get activeSessionId(): string | null {
    return this.state.activeSessionId
  }

  /** Renderer-supplied and therefore untrusted; unknown shapes reset it. */
  setState(raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.state = emptySurfaceState()
      return
    }
    const o = raw as Record<string, unknown>
    const surfaceBySession: Record<string, SurfaceKind> = {}
    const map = o.surfaceBySession
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const [id, kind] of Object.entries(map as Record<string, unknown>)) {
        if (isSurfaceKind(kind)) surfaceBySession[id] = kind
      }
    }
    this.state = {
      activeSessionId:
        typeof o.activeSessionId === "string" && o.activeSessionId !== ""
          ? o.activeSessionId
          : null,
      dockOpen: o.dockOpen === true,
      surfaceBySession,
    }
  }

  async handle(request: SurfaceRequest): Promise<SurfaceResponse> {
    try {
      return {
        id: request.id,
        ok: true,
        result: { summary: await this.run(request) },
      }
    } catch (err) {
      return {
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private run(request: SurfaceRequest): Promise<string> {
    const session = this.deps.session(request.sessionId)
    if (!session) throw new Error(UNKNOWN_SESSION)
    const params = request.params ?? {}
    switch (request.op) {
      case SURFACE_OPS.open:
        return this.openSurface(session, params)
      case SURFACE_OPS.close:
        return Promise.resolve(this.closeDock(session))
      case SURFACE_OPS.status:
        return Promise.resolve(describeDockState(session, this.state))
      case SURFACE_OPS.script:
        return this.runScript(session, params)
      case SURFACE_OPS.boardAdd:
        return this.addTodo(session, params)
      case SURFACE_OPS.boardCheck:
        return this.checkTodo(session, params)
      default:
        throw new Error(
          `Unknown surface operation ${quote(request.op)}.`,
        )
    }
  }

  private onScreen(sessionId: string): boolean {
    return this.state.activeSessionId === sessionId
  }

  /**
   * The dock's open/closed flag is one flag for the whole window, not one per
   * session, so a background session closing it would take the panel away from
   * whoever is on screen. It is refused rather than deferred.
   */
  private closeDock(session: SurfaceSession): string {
    if (!this.onScreen(session.id)) {
      return `Session ${quote(session.title)} is not on screen, so the panel was left as it is.`
    }
    this.deps.open({
      sessionId: session.id,
      surface: null,
      path: null,
      directory: false,
      line: null,
      command: null,
      at: Date.now(),
    })
    this.deps.note(session.id, "Agent closed the surface panel.")
    return "Closed the panel."
  }

  /**
   * Push the choice to the renderer and record it in the transcript. Returns
   * whether the panel actually moved: for a session that is not the one on
   * screen the choice is remembered for later and nothing visible changes.
   */
  private reveal(
    session: SurfaceSession,
    target: Target,
    lead: string,
  ): boolean {
    const live = this.onScreen(session.id)
    this.deps.open({
      sessionId: session.id,
      surface: target.surface,
      path: live ? target.path : null,
      directory: target.directory,
      line: live ? target.line : null,
      command: live ? target.command : null,
      at: Date.now(),
    })
    const label = SURFACE_LABEL[target.surface]
    this.deps.note(
      session.id,
      live
        ? `${lead} the ${label} panel${where(target.path, target.line)}.`
        : `Agent set this session's panel to ${label} — not shown, another session is on screen.`,
    )
    return live
  }

  private resolvePath(
    session: SurfaceSession,
    surface: SurfaceKind,
    params: Record<string, unknown>,
  ): { path: string; directory: boolean } | null {
    const raw = params.path
    if (raw === undefined || raw === null || raw === "") return null
    if (!PATH_SURFACES.has(surface)) {
      throw new Error(
        `The ${SURFACE_LABEL[surface]} surface takes no path — drop "path", or open diff, files or design instead.`,
      )
    }
    const contained = resolveContainedPath(session.cwd, raw)
    if (contained.relativePath === "") {
      throw new Error('"path" must name a file or folder inside the project.')
    }
    const directory = statSync(contained.absolutePath).isDirectory()
    if (directory && surface === "diff") {
      throw new Error(
        `Diff shows one file at a time, and ${contained.relativePath} is a folder.`,
      )
    }
    if (!directory && surface === "design") {
      throw new Error(
        `Design shows a folder of .dc.html artboards, and ${contained.relativePath} is a file.`,
      )
    }
    return { path: contained.relativePath, directory }
  }

  private lineOf(params: Record<string, unknown>): number | null {
    const raw = params.line
    if (raw === undefined || raw === null) return null
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
      throw new Error('"line" must be a whole line number, 1 or greater.')
    }
    return raw
  }

  private openSurface(
    session: SurfaceSession,
    params: Record<string, unknown>,
  ): Promise<string> {
    const surface = params.surface
    if (!isSurfaceKind(surface)) {
      throw new Error(
        `${JSON.stringify(surface ?? "")} is not a Chat Hub surface. Pick one of: ${KIND_LIST}.`,
      )
    }
    const target = this.resolvePath(session, surface, params)
    const line = target && !target.directory ? this.lineOf(params) : null
    const live = this.reveal(
      session,
      {
        surface,
        path: target?.path ?? null,
        directory: target?.directory === true,
        line,
        command: null,
      },
      "Agent opened",
    )
    const label = SURFACE_LABEL[surface]
    if (live) {
      return Promise.resolve(
        `Opened the ${label} panel${where(target?.path ?? null, line)}.`,
      )
    }
    return Promise.resolve(
      `Session ${quote(session.title)} is not on screen, so nothing moved. Its panel is set to ${label} for when it is selected${target ? "; the file was not opened" : ""}.`,
    )
  }

  private async runScript(
    session: SurfaceSession,
    params: Record<string, unknown>,
  ): Promise<string> {
    const wanted = str(params.script).trim()
    if (wanted === "") throw new Error('surface_run_script requires "script".')
    const file = await readScripts(session.cwd)
    const script = findScript(file.scripts, wanted)
    if (!script) {
      throw new Error(
        file.scripts.length === 0
          ? `This project has no saved scripts, so ${quote(wanted)} cannot be run. Add one from the Hub's scripts menu.`
          : `No project script named ${quote(wanted)}. Available: ${scriptNames(file.scripts)}.`,
      )
    }
    const live = this.onScreen(session.id)
    this.deps.open({
      sessionId: session.id,
      surface: "terminal",
      path: null,
      directory: false,
      line: null,
      command: live ? script.command : null,
      at: Date.now(),
    })
    this.deps.note(
      session.id,
      live
        ? `Agent opened the Terminal panel and ran ${quote(script.name)} (${script.command}).`
        : `Agent set this session's panel to Terminal — not shown, and ${quote(script.name)} was not started.`,
    )
    return live
      ? `Opened the Terminal panel and started ${quote(script.name)} (${script.command}).`
      : `Session ${quote(session.title)} is not on screen and its terminal is not running, so ${quote(script.name)} was not started. Its panel is set to Terminal for when it is selected.`
  }

  private async addTodo(
    session: SurfaceSession,
    params: Record<string, unknown>,
  ): Promise<string> {
    const text = str(params.text).trim()
    if (text === "") throw new Error('surface_board_add requires "text".')
    const disk = await readBoard(session.cwd)
    const now = Date.now()
    const next: Board = {
      todos: [
        ...disk.todos,
        { id: `t-${randomUUID()}`, text, done: false, createdAt: now, updatedAt: now },
      ],
      notes: disk.notes,
      updatedAt: disk.updatedAt,
    }
    const saved = await writeBoard(session.cwd, next)
    const live = this.boardReveal(session, `Agent added a board todo`, text)
    return `Added the todo ${quote(text)} to the board — ${countTodos(saved.todos)}.${live ? " The Board panel is open." : ` Session ${quote(session.title)} is not on screen, so its panel is set to Board for when it is selected.`}`
  }

  private async checkTodo(
    session: SurfaceSession,
    params: Record<string, unknown>,
  ): Promise<string> {
    const wanted = str(params.todo).trim()
    if (wanted === "") throw new Error('surface_board_check requires "todo".')
    const done = params.done === undefined ? true : params.done === true
    const disk = await readBoard(session.cwd)
    const match = matchBoardTodo(disk.todos, wanted)
    if (match.kind === "none") {
      throw new Error(
        disk.todos.length === 0
          ? "The board has no todos yet."
          : `No board todo matches ${quote(wanted)}. The board holds:\n${listTodos(disk.todos)}`,
      )
    }
    if (match.kind === "many") {
      throw new Error(
        `${quote(wanted)} matches ${match.todos.length} todos:\n${listTodos(match.todos)}\nUse the exact text or the todo's id.`,
      )
    }
    const target = match.todo
    const now = Date.now()
    const next: Board = {
      todos: disk.todos.map((t) =>
        t.id === target.id ? { ...t, done, updatedAt: now } : t,
      ),
      notes: disk.notes,
      updatedAt: disk.updatedAt,
    }
    const saved = await writeBoard(session.cwd, next)
    const verb = done ? "ticked" : "unticked"
    const live = this.boardReveal(
      session,
      `Agent ${verb} a board todo`,
      target.text,
    )
    return `${done ? "Ticked" : "Unticked"} ${quote(target.text)} — ${countTodos(saved.todos)}.${live ? " The Board panel is open." : ` Session ${quote(session.title)} is not on screen, so its panel is set to Board for when it is selected.`}`
  }

  /** Board edits land on disk either way; only the panel waits for the user. */
  private boardReveal(
    session: SurfaceSession,
    lead: string,
    text: string,
  ): boolean {
    const live = this.onScreen(session.id)
    this.deps.open({
      sessionId: session.id,
      surface: "board",
      path: null,
      directory: false,
      line: null,
      command: null,
      at: Date.now(),
    })
    this.deps.note(
      session.id,
      live
        ? `${lead} and opened the Board panel: ${quote(text)}.`
        : `${lead}: ${quote(text)}.`,
    )
    return live
  }
}
