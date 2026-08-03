import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import type { Board, BoardTodo } from "../src/shared/surfaces"
import { readBoard, writeBoard } from "../src/main/surfaces/board"

let root = ""
let file = ""

/** Write board.json the way the agent does: by hand, straight to the file. */
async function agentWrite(raw: unknown): Promise<void> {
  await mkdir(join(root, ".chathub"), { recursive: true })
  await writeFile(file, JSON.stringify(raw, null, 2), "utf8")
}

async function onDisk(): Promise<Board> {
  return JSON.parse(await readFile(file, "utf8")) as Board
}

const todo = (t: Partial<BoardTodo> & { text: string }): BoardTodo => ({
  id: t.id ?? t.text,
  text: t.text,
  done: t.done ?? false,
  createdAt: t.createdAt ?? 1000,
  ...(t.updatedAt === undefined ? {} : { updatedAt: t.updatedAt }),
})

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "chat-hub-board-")))
  file = join(root, ".chathub", "board.json")
})

describe("readBoard", () => {
  it("reads a legacy board.json that has no updatedAt anywhere", async () => {
    await agentWrite({
      todos: [{ id: "a", text: "ship it", done: true, createdAt: 5 }],
      notes: [{ id: "n1", text: "context", createdAt: 6 }],
    })
    const board = await readBoard(root)
    expect(board.todos).toEqual([
      { id: "a", text: "ship it", done: true, createdAt: 5, updatedAt: expect.any(Number) },
    ])
    expect(board.notes[0]?.id).toBe("n1")
    // Board + item stamps fall back to the file's mtime so the poll sees edits.
    expect(board.updatedAt).toBeGreaterThan(0)
    expect(board.todos[0]?.updatedAt).toBe(board.updatedAt)
  })

  it("is an empty board when the file was never written", async () => {
    await expect(readBoard(root)).resolves.toEqual({ todos: [], notes: [] })
  })

  it("throws on a malformed file instead of pretending the board is empty", async () => {
    await agentWrite("not json")
    await writeFile(file, "{ this is not json", "utf8")
    await expect(readBoard(root)).rejects.toThrow()
  })

  it("throws on an invalid workspace, like writeBoard does", async () => {
    await expect(readBoard(join(root, "nope"))).rejects.toThrow(/Workspace not found/)
    await expect(readBoard(42)).rejects.toThrow(/Invalid workspace path/)
    await expect(writeBoard(42, { todos: [], notes: [] })).rejects.toThrow(
      /Invalid workspace path/,
    )
  })

  it("generates ids for id-less items and persists them to the file", async () => {
    await agentWrite({
      todos: [{ text: "one" }, { text: "two" }],
      notes: [{ text: "n" }],
    })
    const first = await readBoard(root)
    const ids = first.todos.map((t) => t.id)
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).not.toBe(ids[1])

    const persisted = await onDisk()
    expect(persisted.todos.map((t) => t.id)).toEqual(ids)
    expect(persisted.notes[0]?.id).toBe(first.notes[0]?.id)

    // Same ids on the next read — they no longer come from the array index.
    const second = await readBoard(root)
    expect(second.todos.map((t) => t.id)).toEqual(ids)
  })

  it("keeps unknown agent-authored fields when backfilling ids", async () => {
    await agentWrite({ todos: [{ text: "one", priority: "high" }], notes: [] })
    await readBoard(root)
    const persisted = (await onDisk()) as unknown as {
      todos: Record<string, unknown>[]
    }
    expect(persisted.todos[0]?.priority).toBe("high")
  })
})

describe("stable ids across deletes", () => {
  it("does not shift ids when an item is removed from the middle", async () => {
    await agentWrite({ todos: [{ text: "a" }, { text: "b" }, { text: "c" }], notes: [] })
    const board = await readBoard(root)
    const [a, b, c] = board.todos.map((t) => t.id)

    // The UI deletes the middle row and writes its snapshot back.
    const afterDelete = await writeBoard(root, {
      ...board,
      todos: board.todos.filter((t) => t.id !== b),
    })
    expect(afterDelete.todos.map((t) => t.id)).toEqual([a, c])

    // Toggling the (now second) row still hits the row the user clicked.
    const toggled = await writeBoard(root, {
      ...afterDelete,
      todos: afterDelete.todos.map((t) => (t.id === c ? { ...t, done: true } : t)),
    })
    expect(toggled.todos.find((t) => t.id === c)?.done).toBe(true)
    expect(toggled.todos.find((t) => t.id === a)?.done).toBe(false)
  })
})

describe("per-item merge", () => {
  it("keeps a concurrent agent addition when the UI writes a stale snapshot", async () => {
    await agentWrite({
      updatedAt: 1_000,
      todos: [todo({ id: "a", text: "a", updatedAt: 1_000 })],
      notes: [],
    })
    const snapshot = await readBoard(root) // UI snapshot at version 1000

    // Agent adds a todo directly to the file after the UI read it.
    await agentWrite({
      updatedAt: 2_000,
      todos: [
        todo({ id: "a", text: "a", updatedAt: 1_000 }),
        todo({ id: "b", text: "agent task", updatedAt: 2_000 }),
      ],
      notes: [],
    })

    // UI toggles "a" on its stale snapshot — it has never seen "b".
    const merged = await writeBoard(root, {
      ...snapshot,
      todos: snapshot.todos.map((t) => ({ ...t, done: true })),
    })
    expect(merged.todos.map((t) => t.id).sort()).toEqual(["a", "b"])
    expect(merged.todos.find((t) => t.id === "a")?.done).toBe(true)
    expect(merged.todos.find((t) => t.id === "b")?.text).toBe("agent task")
  })

  it("keeps an agent edit to a row the UI merely echoed back", async () => {
    await agentWrite({
      updatedAt: 1_000,
      todos: [
        todo({ id: "a", text: "old text", updatedAt: 1_000 }),
        todo({ id: "b", text: "b", updatedAt: 1_000 }),
      ],
      notes: [],
    })
    const snapshot = await readBoard(root)

    await agentWrite({
      updatedAt: 3_000,
      todos: [
        todo({ id: "a", text: "agent rewrote this", updatedAt: 3_000 }),
        todo({ id: "b", text: "b", updatedAt: 1_000 }),
      ],
      notes: [],
    })

    // The UI touches only "b" and echoes "a" unchanged.
    const merged = await writeBoard(root, {
      ...snapshot,
      todos: snapshot.todos.map((t) => (t.id === "b" ? { ...t, done: true } : t)),
    })
    expect(merged.todos.find((t) => t.id === "a")?.text).toBe("agent rewrote this")
    expect(merged.todos.find((t) => t.id === "b")?.done).toBe(true)
  })

  it("lets a writer that stamps the row it edited win the collision", async () => {
    await agentWrite({
      updatedAt: 1_000,
      todos: [todo({ id: "a", text: "old text", updatedAt: 1_000 })],
      notes: [],
    })
    const snapshot = await readBoard(root)
    await agentWrite({
      updatedAt: 3_000,
      todos: [todo({ id: "a", text: "agent rewrote this", updatedAt: 3_000 })],
      notes: [],
    })
    const merged = await writeBoard(root, {
      ...snapshot,
      todos: snapshot.todos.map((t) => ({ ...t, done: true, updatedAt: 4_000 })),
    })
    expect(merged.todos[0]?.done).toBe(true)
    expect(merged.todos[0]?.text).toBe("old text")
  })

  it("merges notes independently of todos", async () => {
    await agentWrite({ updatedAt: 1_000, todos: [], notes: [] })
    const snapshot = await readBoard(root)
    await agentWrite({
      updatedAt: 2_000,
      todos: [],
      notes: [{ id: "n2", text: "agent note", createdAt: 1, updatedAt: 2_000 }],
    })
    const merged = await writeBoard(root, {
      ...snapshot,
      notes: [{ id: "n1", text: "user note", createdAt: 2 }],
    })
    expect(merged.notes.map((n) => n.id).sort()).toEqual(["n1", "n2"])
  })

  it("deletes an item the writer saw and left out", async () => {
    await agentWrite({
      updatedAt: 1_000,
      todos: [
        todo({ id: "a", text: "a", updatedAt: 1_000 }),
        todo({ id: "b", text: "b", updatedAt: 1_000 }),
      ],
      notes: [],
    })
    const snapshot = await readBoard(root)
    const merged = await writeBoard(root, {
      ...snapshot,
      todos: snapshot.todos.filter((t) => t.id !== "b"),
    })
    expect(merged.todos.map((t) => t.id)).toEqual(["a"])
    expect((await onDisk()).todos.map((t) => t.id)).toEqual(["a"])
  })

  it("treats a writer with no board version as authoritative", async () => {
    await agentWrite({
      updatedAt: 1_000,
      todos: [todo({ id: "a", text: "a", updatedAt: 1_000 })],
      notes: [],
    })
    const merged = await writeBoard(root, { todos: [], notes: [] })
    expect(merged.todos).toEqual([])
  })

  it("stamps every persisted item and bumps the board version", async () => {
    const before = Date.now()
    const merged = await writeBoard(root, {
      todos: [{ id: "a", text: "a", done: false, createdAt: 1 }],
      notes: [],
    })
    expect(merged.todos[0]?.updatedAt).toBeGreaterThanOrEqual(before)
    expect(merged.updatedAt).toBeGreaterThanOrEqual(before)
    expect((await onDisk()).todos[0]?.updatedAt).toBe(merged.todos[0]?.updatedAt)
  })
})
