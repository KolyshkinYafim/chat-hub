import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SURFACE_OPS, type SurfaceOpenRequest } from "../src/shared/surface-control"
import type { Board, BoardTodo } from "../src/shared/surfaces"
import {
  SurfaceControl,
  describeDockState,
  matchBoardTodo,
  type SurfaceSession,
} from "../src/main/surfaces/surface-control"
import { asText } from "../src/shared/text"

const HERE = "s-here"
const AWAY = "s-away"

let root = ""
let outside = ""
let control: SurfaceControl
let opens: SurfaceOpenRequest[] = []
let notes: { sessionId: string; text: string }[] = []
const dirs: string[] = []

function sessionOf(id: string): SurfaceSession | null {
  if (id === HERE) return { id: HERE, title: "On screen", cwd: root }
  if (id === AWAY) return { id: AWAY, title: "Elsewhere", cwd: root }
  return null
}

async function call(
  op: string,
  params: Record<string, unknown> = {},
  sessionId = HERE,
): Promise<{ ok: boolean; text: string }> {
  const response = await control.handle({ id: "r1", sessionId, op, params })
  return response.ok
    ? { ok: true, text: asText(response.result.summary) }
    : { ok: false, text: response.error }
}

function boardOnDisk(): Board {
  return JSON.parse(
    readFileSync(join(root, ".chathub", "board.json"), "utf8"),
  ) as Board
}

beforeEach(async () => {
  const base = realpathSync(await mkdtemp(join(tmpdir(), "chat-hub-surface-")))
  dirs.push(base)
  root = join(base, "workspace")
  outside = join(base, "secrets")
  await mkdir(join(root, "src"), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, "src", "app.ts"), "export const app = 1\n", "utf8")
  await writeFile(join(outside, "passwd"), "root:x:0:0\n", "utf8")
  await symlink(join(outside, "passwd"), join(root, "escape-file"))

  opens = []
  notes = []
  control = new SurfaceControl({
    session: sessionOf,
    note: (sessionId, text) => notes.push({ sessionId, text }),
    open: (request) => opens.push(request),
  })
  control.setState({
    activeSessionId: HERE,
    dockOpen: true,
    surfaceBySession: { [HERE]: "diff" },
  })
})

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function todo(text: string, done = false, id = text): BoardTodo {
  return { id, text, done, createdAt: 1 }
}

describe("matchBoardTodo", () => {
  const todos = [todo("Ship the parser", false, "t-1"), todo("Ship it", true, "t-2")]

  it("matches an id exactly", () => {
    expect(matchBoardTodo(todos, "t-2")).toEqual({ kind: "one", todo: todos[1] })
  })

  it("prefers an exact text match over the substring it is contained in", () => {
    expect(matchBoardTodo(todos, "ship it")).toEqual({
      kind: "one",
      todo: todos[1],
    })
  })

  it("reports every candidate when a substring is ambiguous", () => {
    expect(matchBoardTodo(todos, "ship")).toEqual({ kind: "many", todos })
  })

  it("finds nothing for an empty or absent needle", () => {
    expect(matchBoardTodo(todos, "  ")).toEqual({ kind: "none" })
    expect(matchBoardTodo(todos, "deploy")).toEqual({ kind: "none" })
  })
})

describe("describeDockState", () => {
  const here: SurfaceSession = { id: HERE, title: "On screen", cwd: "/tmp" }

  it("names the open surface for the session on screen", () => {
    const text = describeDockState(here, {
      activeSessionId: HERE,
      dockOpen: true,
      surfaceBySession: { [HERE]: "files" },
    })
    expect(text).toContain("This session is on screen")
    expect(text).toContain("The dock is open on Files.")
  })

  it("says the dock is closed and what it would reopen on", () => {
    const text = describeDockState(here, {
      activeSessionId: HERE,
      dockOpen: false,
      surfaceBySession: { [HERE]: "board" },
    })
    expect(text).toContain("closed; it would reopen on Board")
  })

  it("says nothing on screen would change for a background session", () => {
    const text = describeDockState(here, {
      activeSessionId: AWAY,
      dockOpen: true,
      surfaceBySession: {},
    })
    expect(text).toContain("changes nothing on screen")
    expect(text).toContain("no panel chosen yet")
  })
})

describe("surface.open", () => {
  it("refuses a session Chat Hub does not have", async () => {
    const result = await call(SURFACE_OPS.open, { surface: "diff" }, "ghost")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("not open in Chat Hub")
    expect(opens).toHaveLength(0)
  })

  it("opens the diff panel on a file and traces it in the transcript", async () => {
    const result = await call(SURFACE_OPS.open, {
      surface: "diff",
      path: "src/app.ts",
    })
    expect(result.ok).toBe(true)
    expect(result.text).toBe("Opened the Diff panel on src/app.ts.")
    expect(opens).toEqual([
      {
        sessionId: HERE,
        surface: "diff",
        path: "src/app.ts",
        directory: false,
        line: null,
        command: null,
        at: expect.any(Number),
      },
    ])
    expect(notes).toEqual([
      { sessionId: HERE, text: "Agent opened the Diff panel on src/app.ts." },
    ])
  })

  it("carries a line into the files surface", async () => {
    const result = await call(SURFACE_OPS.open, {
      surface: "files",
      path: "src/app.ts",
      line: 12,
    })
    expect(result.text).toBe("Opened the Files panel on src/app.ts:12.")
    expect(opens[0]?.line).toBe(12)
  })

  it("marks a folder so files expands it instead of opening it", async () => {
    await call(SURFACE_OPS.open, { surface: "files", path: "src" })
    expect(opens[0]).toMatchObject({ path: "src", directory: true, line: null })
  })

  it("refuses a folder in the diff panel", async () => {
    const result = await call(SURFACE_OPS.open, { surface: "diff", path: "src" })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("is a folder")
  })

  it("refuses a path on a surface that has none", async () => {
    const result = await call(SURFACE_OPS.open, {
      surface: "board",
      path: "src/app.ts",
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("takes no path")
  })

  it("refuses a path that leaves the project", async () => {
    const escapes = await call(SURFACE_OPS.open, {
      surface: "files",
      path: "../secrets/passwd",
    })
    expect(escapes.ok).toBe(false)
    expect(escapes.text).toMatch(/escapes the workspace/)

    const link = await call(SURFACE_OPS.open, {
      surface: "files",
      path: "escape-file",
    })
    expect(link.ok).toBe(false)
    expect(link.text).toMatch(/escapes the workspace/)

    const absolute = await call(SURFACE_OPS.open, {
      surface: "files",
      path: join(outside, "passwd"),
    })
    expect(absolute.ok).toBe(false)
    expect(absolute.text).toMatch(/must be relative/)
    expect(opens).toHaveLength(0)
  })

  it("refuses a surface it does not have", async () => {
    const result = await call(SURFACE_OPS.open, { surface: "inspector" })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("is not a Chat Hub surface")
  })

  it("refuses a line that is not a line number", async () => {
    const result = await call(SURFACE_OPS.open, {
      surface: "files",
      path: "src/app.ts",
      line: 0,
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('"line" must be')
  })

  it("records the choice for a background session without moving anything", async () => {
    const result = await call(
      SURFACE_OPS.open,
      { surface: "diff", path: "src/app.ts" },
      AWAY,
    )
    expect(result.ok).toBe(true)
    expect(result.text).toContain("is not on screen")
    expect(result.text).toContain("the file was not opened")
    expect(opens[0]).toMatchObject({
      sessionId: AWAY,
      surface: "diff",
      path: null,
      line: null,
      command: null,
    })
    expect(notes[0]).toEqual({
      sessionId: AWAY,
      text: "Agent set this session's panel to Diff — not shown, another session is on screen.",
    })
  })
})

describe("surface.close", () => {
  it("closes the panel for the session on screen and says so", async () => {
    const result = await call(SURFACE_OPS.close)
    expect(result.ok).toBe(true)
    expect(result.text).toBe("Closed the panel.")
    expect(opens[0]).toMatchObject({ sessionId: HERE, surface: null })
    expect(notes[0]).toEqual({
      sessionId: HERE,
      text: "Agent closed the surface panel.",
    })
  })

  it("refuses to close the dock on behalf of a background session", async () => {
    const result = await call(SURFACE_OPS.close, {}, AWAY)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("left as it is")
    expect(opens).toHaveLength(0)
    expect(notes).toHaveLength(0)
  })
})

describe("surface.status", () => {
  it("answers without opening anything or writing a note", async () => {
    const result = await call(SURFACE_OPS.status)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("The dock is open on Diff.")
    expect(opens).toHaveLength(0)
    expect(notes).toHaveLength(0)
  })

  it("falls back to nothing-on-screen when the renderer reports junk", async () => {
    control.setState("not a report")
    const result = await call(SURFACE_OPS.status)
    expect(result.text).toContain("No session is on screen")
  })

  it("ignores surfaces the renderer does not have", async () => {
    control.setState({
      activeSessionId: HERE,
      dockOpen: true,
      surfaceBySession: { [HERE]: "inspector" },
    })
    const result = await call(SURFACE_OPS.status)
    expect(result.text).toContain("the surface chooser")
  })
})

describe("surface.script", () => {
  async function saveScripts(scripts: unknown[]): Promise<void> {
    await mkdir(join(root, ".chathub"), { recursive: true })
    await writeFile(
      join(root, ".chathub", "scripts.json"),
      JSON.stringify({ scripts, updatedAt: 1 }),
      "utf8",
    )
  }

  it("says so when the project has no saved scripts", async () => {
    const result = await call(SURFACE_OPS.script, { script: "dev" })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("no saved scripts")
  })

  it("lists the scripts it does have when the name is wrong", async () => {
    await saveScripts([{ id: "a", name: "dev", command: "pnpm dev" }])
    const result = await call(SURFACE_OPS.script, { script: "build" })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("Available: dev.")
  })

  it("opens the terminal and hands over the saved command", async () => {
    await saveScripts([{ id: "a", name: "Dev", command: "pnpm dev" }])
    const result = await call(SURFACE_OPS.script, { script: "dev" })
    expect(result.text).toBe('Opened the Terminal panel and started "Dev" (pnpm dev).')
    expect(opens[0]).toMatchObject({ surface: "terminal", command: "pnpm dev" })
    expect(notes[0]?.text).toContain("ran \"Dev\" (pnpm dev)")
  })

  it("does not start a script for a session the user cannot see", async () => {
    await saveScripts([{ id: "a", name: "Dev", command: "pnpm dev" }])
    const result = await call(SURFACE_OPS.script, { script: "Dev" }, AWAY)
    expect(result.ok).toBe(true)
    expect(result.text).toContain("was not started")
    expect(opens[0]).toMatchObject({ surface: "terminal", command: null })
    expect(notes[0]?.text).toContain("was not started")
  })
})

describe("the board tools", () => {
  it("adds a todo, opens the board and counts what is left", async () => {
    const result = await call(SURFACE_OPS.boardAdd, { text: "Ship the parser" })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Added the todo "Ship the parser"')
    expect(result.text).toContain("1 open, 0 done")
    expect(boardOnDisk().todos.map((t) => t.text)).toEqual(["Ship the parser"])
    expect(opens[0]).toMatchObject({ surface: "board" })
    expect(notes[0]?.text).toBe(
      'Agent added a board todo and opened the Board panel: "Ship the parser".',
    )
  })

  it("refuses an empty todo", async () => {
    const result = await call(SURFACE_OPS.boardAdd, { text: "   " })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('requires "text"')
  })

  it("writes the board even for a session that is not on screen", async () => {
    const result = await call(
      SURFACE_OPS.boardAdd,
      { text: "Ship the parser" },
      AWAY,
    )
    expect(result.text).toContain("is not on screen")
    expect(boardOnDisk().todos).toHaveLength(1)
    expect(notes[0]?.text).toBe('Agent added a board todo: "Ship the parser".')
  })

  it("ticks a todo by a unique part of its text", async () => {
    await call(SURFACE_OPS.boardAdd, { text: "Ship the parser" })
    opens = []
    notes = []
    const result = await call(SURFACE_OPS.boardCheck, { todo: "parser" })
    expect(result.text).toContain('Ticked "Ship the parser"')
    expect(result.text).toContain("0 open, 1 done")
    expect(boardOnDisk().todos[0].done).toBe(true)
    expect(notes[0]?.text).toContain("ticked a board todo")
  })

  it("unticks with done=false", async () => {
    await call(SURFACE_OPS.boardAdd, { text: "Ship the parser" })
    await call(SURFACE_OPS.boardCheck, { todo: "parser" })
    const result = await call(SURFACE_OPS.boardCheck, {
      todo: "parser",
      done: false,
    })
    expect(result.text).toContain('Unticked "Ship the parser"')
    expect(boardOnDisk().todos[0].done).toBe(false)
  })

  it("asks for a sharper match instead of guessing", async () => {
    await call(SURFACE_OPS.boardAdd, { text: "Ship the parser" })
    await call(SURFACE_OPS.boardAdd, { text: "Ship the docs" })
    const result = await call(SURFACE_OPS.boardCheck, { todo: "ship" })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("matches 2 todos")
    expect(result.text).toContain("- Ship the docs")
  })

  it("lists the board when nothing matches", async () => {
    await call(SURFACE_OPS.boardAdd, { text: "Ship the parser" })
    const result = await call(SURFACE_OPS.boardCheck, { todo: "deploy" })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("- Ship the parser")
  })

  it("says the board is empty rather than listing nothing", async () => {
    const result = await call(SURFACE_OPS.boardCheck, { todo: "deploy" })
    expect(result.ok).toBe(false)
    expect(result.text).toBe("The board has no todos yet.")
  })
})

describe("unknown ops", () => {
  it("are refused by name", async () => {
    const result = await call("surface.teleport")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("surface.teleport")
  })
})
