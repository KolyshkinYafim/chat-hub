import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute } from "node:path"

export type EditPair = { oldText: string; newText: string }

export type EditDiff = {
  text: string
  added: number
  removed: number
  absoluteLines: boolean
}

const CONTEXT_LINES = 3
const MAX_LCS_LINES = 600
const MAX_BODY_LINES = 400

export function buildEditDiff(file: string, pairs: EditPair[]): EditDiff {
  let working = readSource(file)
  const body: string[] = []
  let added = 0
  let removed = 0
  let absoluteLines = true

  for (const pair of pairs) {
    const placed = locate(working, pair)
    if (placed === null) absoluteLines = false
    const start = placed?.line ?? 1
    const ops = diffLines(splitLines(pair.oldText), splitLines(pair.newText))
    for (const op of ops) {
      if (op.kind === "+") added += 1
      if (op.kind === "-") removed += 1
    }
    for (const hunk of toHunks(ops, start, start)) body.push(...hunk)
    working = applyEdit(working, pair, placed)
  }

  return {
    text: capped(body),
    added,
    removed,
    absoluteLines: absoluteLines && body.length > 0,
  }
}

const MAX_SOURCE_BYTES = 2_000_000

function readSource(file: string): string | null {
  if (!file || !isAbsolute(file)) return null
  try {
    if (!existsSync(file)) return null
    if (statSync(file).size > MAX_SOURCE_BYTES) return null
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

type Placement = { index: number; line: number; wholeFile: boolean }

function locate(source: string | null, pair: EditPair): Placement | null {
  if (pair.oldText === "") return { index: 0, line: 1, wholeFile: true }
  if (source === null) return null
  const index = source.indexOf(pair.oldText)
  if (index === -1) return null
  return {
    index,
    line: countLines(source.slice(0, index)) + 1,
    wholeFile: false,
  }
}

function applyEdit(
  source: string | null,
  pair: EditPair,
  placed: Placement | null,
): string | null {
  if (placed === null) return source
  if (placed.wholeFile) return pair.newText
  if (source === null) return null
  return (
    source.slice(0, placed.index) +
    pair.newText +
    source.slice(placed.index + pair.oldText.length)
  )
}

function countLines(text: string): number {
  let count = 0
  for (const ch of text) if (ch === "\n") count += 1
  return count
}

function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

type LineOp = { kind: " " | "-" | "+"; text: string }

export function diffLines(oldLines: string[], newLines: string[]): LineOp[] {
  if (oldLines.length === 0) {
    return newLines.map((text) => ({ kind: "+" as const, text }))
  }
  if (newLines.length === 0) {
    return oldLines.map((text) => ({ kind: "-" as const, text }))
  }
  if (oldLines.length > MAX_LCS_LINES || newLines.length > MAX_LCS_LINES) {
    return [
      ...oldLines.map((text) => ({ kind: "-" as const, text })),
      ...newLines.map((text) => ({ kind: "+" as const, text })),
    ]
  }

  const rows = oldLines.length
  const cols = newLines.length
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  )
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j]! =
        oldLines[i] === newLines[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const ops: LineOp[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: " ", text: oldLines[i]! })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "-", text: oldLines[i]! })
      i += 1
    } else {
      ops.push({ kind: "+", text: newLines[j]! })
      j += 1
    }
  }
  while (i < rows) {
    ops.push({ kind: "-", text: oldLines[i]! })
    i += 1
  }
  while (j < cols) {
    ops.push({ kind: "+", text: newLines[j]! })
    j += 1
  }
  return ops
}

function toHunks(
  ops: LineOp[],
  oldStart: number,
  newStart: number,
): string[][] {
  const changed = ops
    .map((op, i) => (op.kind === " " ? -1 : i))
    .filter((i) => i >= 0)
  if (changed.length === 0) return []

  const spans: [number, number][] = []
  for (const i of changed) {
    const from = Math.max(0, i - CONTEXT_LINES)
    const to = Math.min(ops.length - 1, i + CONTEXT_LINES)
    const last = spans[spans.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else spans.push([from, to])
  }

  const oldNumbers: number[] = []
  const newNumbers: number[] = []
  let oldAt = oldStart
  let newAt = newStart
  for (const op of ops) {
    oldNumbers.push(oldAt)
    newNumbers.push(newAt)
    if (op.kind !== "+") oldAt += 1
    if (op.kind !== "-") newAt += 1
  }

  return spans.map(([from, to]) => {
    const slice = ops.slice(from, to + 1)
    const oldCount = slice.filter((op) => op.kind !== "+").length
    const newCount = slice.filter((op) => op.kind !== "-").length
    const header = `@@ -${oldNumbers[from]},${oldCount} +${newNumbers[from]},${newCount} @@`
    return [header, ...slice.map((op) => `${op.kind} ${op.text}`)]
  })
}

function capped(body: string[]): string {
  if (body.length <= MAX_BODY_LINES) return body.join("\n")
  const extra = body.length - MAX_BODY_LINES
  return `${body.slice(0, MAX_BODY_LINES).join("\n")}\n… (${extra} more lines)`
}
