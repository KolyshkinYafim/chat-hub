export type DiffRowKind = "context" | "add" | "del"

export type DiffRow = {
  kind: DiffRowKind
  text: string
  oldLine: number | null
  newLine: number | null
  changed: [number, number][]
}

export type DiffHunk = {
  oldStart: number
  newStart: number
  rows: DiffRow[]
}

export type ParsedDiff = {
  hunks: DiffHunk[]
  added: number
  removed: number
  truncated: boolean
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const TRUNCATION = /^… \(\d+ more lines\)$/

export function parseDiff(text: string): ParsedDiff {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let oldLine = 1
  let newLine = 1
  let added = 0
  let removed = 0
  let truncated = false

  const open = (oldStart: number, newStart: number) => {
    current = { oldStart, newStart, rows: [] }
    hunks.push(current)
    oldLine = oldStart
    newLine = newStart
  }

  for (const raw of text.split("\n")) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      open(Number(header[1]), Number(header[3]))
      continue
    }
    if (TRUNCATION.test(raw.trim())) {
      truncated = true
      continue
    }
    if (!current) open(1, 1)
    const kind = rowKind(raw)
    const body = raw.length >= 2 ? raw.slice(2) : raw.slice(1)
    const row: DiffRow = {
      kind,
      text: body,
      oldLine: kind === "add" ? null : oldLine,
      newLine: kind === "del" ? null : newLine,
      changed: [],
    }
    if (kind !== "add") oldLine += 1
    if (kind !== "del") newLine += 1
    if (kind === "add") added += 1
    if (kind === "del") removed += 1
    current!.rows.push(row)
  }

  for (const hunk of hunks) markWordChanges(hunk.rows)
  return { hunks, added, removed, truncated }
}

function rowKind(line: string): DiffRowKind {
  if (line.startsWith("+")) return "add"
  if (line.startsWith("-")) return "del"
  return "context"
}

const REWRITE_THRESHOLD = 0.5
const MAX_PAIRINGS = 64

function markWordChanges(rows: DiffRow[]): void {
  let i = 0
  while (i < rows.length) {
    if (rows[i]!.kind !== "del") {
      i += 1
      continue
    }
    let delEnd = i
    while (delEnd < rows.length && rows[delEnd]!.kind === "del") delEnd += 1
    let addEnd = delEnd
    while (addEnd < rows.length && rows[addEnd]!.kind === "add") addEnd += 1
    pairRows(rows.slice(i, delEnd), rows.slice(delEnd, addEnd))
    i = addEnd > i ? addEnd : i + 1
  }
}

function pairRows(removed: DiffRow[], added: DiffRow[]): void {
  if (removed.length === 0 || added.length === 0) return

  if (removed.length * added.length > MAX_PAIRINGS) {
    const count = Math.min(removed.length, added.length)
    for (let p = 0; p < count; p += 1) apply(removed[p]!, added[p]!)
    return
  }

  type Candidate = { del: number; add: number; score: number }
  const candidates: Candidate[] = []
  for (let d = 0; d < removed.length; d += 1) {
    for (let a = 0; a < added.length; a += 1) {
      const score = similarity(removed[d]!.text, added[a]!.text)
      if (score >= REWRITE_THRESHOLD) candidates.push({ del: d, add: a, score })
    }
  }
  candidates.sort((x, y) => y.score - x.score)

  const usedDel = new Set<number>()
  const usedAdd = new Set<number>()
  for (const candidate of candidates) {
    if (usedDel.has(candidate.del) || usedAdd.has(candidate.add)) continue
    usedDel.add(candidate.del)
    usedAdd.add(candidate.add)
    apply(removed[candidate.del]!, added[candidate.add]!)
  }
}

function apply(before: DiffRow, after: DiffRow): void {
  const { left, right } = wordRanges(before.text, after.text)
  before.changed = left
  after.changed = right
}

export function similarity(before: string, after: string): number {
  if (before === after) return 1
  const a = tokenize(before).filter((t) => t.text.trim() !== "")
  const b = tokenize(after).filter((t) => t.text.trim() !== "")
  if (a.length === 0 || b.length === 0) return 0
  const common = lcsLength(
    a.map((t) => t.text),
    b.map((t) => t.text),
  )
  return (2 * common) / (a.length + b.length)
}

function lcsLength(a: string[], b: string[]): number {
  if (a.length > 400 || b.length > 400) return 0
  let previous = new Array<number>(b.length + 1).fill(0)
  let current = new Array<number>(b.length + 1).fill(0)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      current[j] =
        a[i] === b[j] ? previous[j + 1]! + 1 : Math.max(previous[j]!, current[j + 1]!)
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  return previous[0]!
}

const WORD = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g

function tokenize(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = []
  let match: RegExpExecArray | null
  WORD.lastIndex = 0
  while ((match = WORD.exec(text)) !== null) {
    out.push({ text: match[0], start: match.index })
  }
  return out
}

export function wordRanges(
  before: string,
  after: string,
): { left: [number, number][]; right: [number, number][] } {
  if (before === after) return { left: [], right: [] }
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length > 400 || b.length > 400) {
    return { left: [[0, before.length]], right: [[0, after.length]] }
  }

  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j]! =
        a[i]!.text === b[j]!.text
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const left: [number, number][] = []
  const right: [number, number][] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i]!.text === b[j]!.text) {
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push(left, a[i]!.start, a[i]!.start + a[i]!.text.length)
      i += 1
    } else {
      push(right, b[j]!.start, b[j]!.start + b[j]!.text.length)
      j += 1
    }
  }
  while (i < a.length) {
    push(left, a[i]!.start, a[i]!.start + a[i]!.text.length)
    i += 1
  }
  while (j < b.length) {
    push(right, b[j]!.start, b[j]!.start + b[j]!.text.length)
    j += 1
  }

  return { left: tighten(left, before), right: tighten(right, after) }
}

function push(ranges: [number, number][], start: number, end: number): void {
  const last = ranges[ranges.length - 1]
  if (last && last[1] === start) last[1] = end
  else ranges.push([start, end])
}

function tighten(
  ranges: [number, number][],
  text: string,
): [number, number][] {
  const out: [number, number][] = []
  for (const [start, end] of ranges) {
    let from = start
    let to = end
    while (from < to && /\s/.test(text[from]!)) from += 1
    while (to > from && /\s/.test(text[to - 1]!)) to -= 1
    if (to > from) out.push([from, to])
  }
  return out
}
