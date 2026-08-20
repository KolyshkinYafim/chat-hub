/** "auto" is a delimiter row with no colons — the data decides the alignment. */
export type Align = "auto" | "left" | "center" | "right"

export type MarkdownTable = {
  head: string[]
  /** One entry per column, exactly as the delimiter row declared it. */
  align: Align[]
  rows: string[][]
}

const DELIMITER_CELL = /^:?-{1,}:?$/

/* The minus is written last on purpose: "+-−" would parse as a character range. */
/** Digits with the separators a report actually uses, so counts right-align. */
const NUMERIC =
  /^[-+\u2212]?[$€£¥]?\d{1,3}(?:[ ,_]\d{3})*(?:\.\d+)?\s?%?$|^[-+\u2212]?\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|k|x)?$/i

/** Cells a column can carry without being disqualified as numeric. */
const NUMERIC_BLANK = /^(?:|-|—|–|n\/a|null|—)$/i

export function splitRow(line: string): string[] {
  const trimmed = line.trim()
  const body =
    trimmed.startsWith("|") && trimmed.length > 1 ? trimmed.slice(1) : trimmed
  const inner = body.endsWith("|") && !body.endsWith("\\|")
    ? body.slice(0, -1)
    : body

  const cells: string[] = []
  let current = ""
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!
    if (char === "\\" && inner[i + 1] === "|") {
      current += "|"
      i += 1
      continue
    }
    if (char === "|") {
      cells.push(current.trim())
      current = ""
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

function looksLikeRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes("|")) return false
  // A single-column table only reads as one when it is fenced by pipes;
  // otherwise a lone escaped pipe in prose would start a table.
  if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1) {
    return true
  }
  return splitRow(trimmed).length >= 2
}

function parseAlign(line: string): Align[] | null {
  if (!looksLikeRow(line)) return null
  const cells = splitRow(line)
  const align: Align[] = []
  for (const cell of cells) {
    if (!DELIMITER_CELL.test(cell)) return null
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    align.push(
      left && right ? "center" : right ? "right" : left ? "left" : "auto",
    )
  }
  return align
}

/**
 * Reads a GFM table starting at `from`. Returns null when the two lines needed
 * for a table (header + delimiter) are not both there — a lone pipe line is
 * prose and has to stay prose.
 */
export function readTable(
  lines: string[],
  from: number,
): { table: MarkdownTable; next: number } | null {
  const header = lines[from]
  const delimiter = lines[from + 1]
  if (header === undefined || delimiter === undefined) return null
  if (!looksLikeRow(header)) return null
  const align = parseAlign(delimiter)
  if (align === null) return null

  const head = splitRow(header)
  if (align.length !== head.length) return null

  const rows: string[][] = []
  let i = from + 2
  while (i < lines.length && looksLikeRow(lines[i]!)) {
    rows.push(fit(splitRow(lines[i]!), head.length))
    i += 1
  }
  return { table: { head, align, rows }, next: i }
}

function fit(cells: string[], width: number): string[] {
  if (cells.length === width) return cells
  if (cells.length > width) return cells.slice(0, width)
  return [...cells, ...Array<string>(width - cells.length).fill("")]
}

export function isNumericCell(text: string): boolean {
  return NUMERIC.test(text.trim())
}

/**
 * Alignment to actually render with: an explicit delimiter wins, otherwise a
 * column of numbers right-aligns so the digits line up.
 */
export function columnAlign(
  table: MarkdownTable,
  column: number,
): Exclude<Align, "auto"> {
  const declared = table.align[column] ?? "auto"
  if (declared !== "auto") return declared

  let numbers = 0
  for (const row of table.rows) {
    const cell = (row[column] ?? "").trim()
    if (NUMERIC_BLANK.test(cell)) continue
    if (!isNumericCell(cell)) return "left"
    numbers += 1
  }
  return numbers > 0 ? "right" : "left"
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function cellWidth(text: string): number {
  return [...text].length
}

function pad(text: string, width: number, align: Align): string {
  const slack = Math.max(0, width - cellWidth(text))
  if (align === "right") return " ".repeat(slack) + text
  if (align === "center") {
    const left = Math.floor(slack / 2)
    return " ".repeat(left) + text + " ".repeat(slack - left)
  }
  return text + " ".repeat(slack)
}

function delimiterCell(width: number, align: Align): string {
  if (align === "center") return `:${"-".repeat(Math.max(1, width - 2))}:`
  if (align === "right") return `${"-".repeat(Math.max(1, width - 1))}:`
  if (align === "left") return `:${"-".repeat(Math.max(2, width - 1))}`
  return "-".repeat(Math.max(3, width))
}

/** Column-padded markdown — what a human pasting into a file wants back. */
export function tableToMarkdown(table: MarkdownTable): string {
  const head = table.head.map(escapeCell)
  const rows = table.rows.map((row) => row.map(escapeCell))
  const widths = head.map((cell, i) =>
    Math.max(
      3,
      cellWidth(cell),
      ...rows.map((row) => cellWidth(row[i] ?? "")),
    ),
  )
  const align = head.map((_, i) => table.align[i] ?? "auto")

  const line = (cells: string[]) =>
    `| ${cells.map((cell, i) => pad(cell, widths[i]!, align[i]!)).join(" | ")} |`

  const out = [
    line(head),
    `| ${widths.map((width, i) => delimiterCell(width, align[i]!)).join(" | ")} |`,
    ...rows.map(line),
  ]
  return out.join("\n")
}

/** Tab-separated, one row per line — pastes into a spreadsheet as cells. */
export function tableToTsv(table: MarkdownTable): string {
  const flat = (cell: string) => cell.replace(/[\t\r\n]+/g, " ").trim()
  return [table.head, ...table.rows]
    .map((row) => row.map(flat).join("\t"))
    .join("\n")
}
