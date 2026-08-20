import { decodeToolCardMeta, type ToolCardMeta } from "@shared/tool-card"
import { readTable, type MarkdownTable } from "./markdown-table"

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/** A bullet or numbered item, with its nesting rank and checkbox if it has one. */
export type ListItem = {
  text: string
  /** 0 for a top-level item; one step per distinct indent inside the list. */
  depth: number
  checked: boolean | null
}

export type DefinitionItem = { term: string; details: string[] }

export type FootnoteItem = { label: string; text: string }

/** Block model for the agent-transcript renderer (see MarkdownBody). */
export type Block =
  | { kind: "h"; level: HeadingLevel; text: string }
  | { kind: "ul"; items: ListItem[] }
  | { kind: "ol"; start: number; items: ListItem[] }
  | { kind: "table"; table: MarkdownTable }
  /** Blockquote content is markdown in its own right — lists and code included. */
  | { kind: "quote"; blocks: Block[] }
  | { kind: "hr" }
  | { kind: "dl"; items: DefinitionItem[] }
  | { kind: "footnotes"; items: FootnoteItem[] }
  | { kind: "code"; lang: string; code: string }
  /** Fenced ```mermaid — rendered as a diagram when the message is final. */
  | { kind: "mermaid"; code: string }
  | { kind: "diff"; code: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool"
      name: string
      body: string
      /** Call id, CLI description, touched paths, exit code — see ToolCardMeta. */
      meta: ToolCardMeta
      result?: boolean
    }
  /** TodoWrite / update_plan — checklist card, not a generic tool row. */
  | {
      kind: "plan"
      name: string
      body: string
      meta: ToolCardMeta
    }
  | { kind: "p"; text: string }

const FENCE = /^(`{3,})(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const SETEXT = /^\s*={2,}\s*$/
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const BULLET = /^(\s*)([-*+•✅])\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const TASK = /^\[([ xX])\]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const DEFINITION = /^\s{0,3}:\s+(.*)$/
const FOOTNOTE = /^\[\^([^\]\s]+)\]:\s*(.*)$/
const MAX_LIST_DEPTH = 5

export function splitBlocks(src: string): Block[] {
  return parseLines(src.replace(/\r\n/g, "\n").split("\n"))
}

function parseLines(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (line.trim() === "") {
      i += 1
      continue
    }

    const opening = FENCE.exec(line)
    if (opening) {
      i = readFence(lines, i, opening, out)
      continue
    }

    if (RULE.test(line)) {
      out.push({ kind: "hr" })
      i += 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({
        kind: "h",
        level: heading[1]!.length as HeadingLevel,
        text: heading[2]!,
      })
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      i = readQuote(lines, i, out)
      continue
    }

    const table = readTable(lines, i)
    if (table) {
      out.push({ kind: "table", table: table.table })
      i = table.next
      continue
    }

    if (FOOTNOTE.test(line)) {
      i = readFootnotes(lines, i, out)
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      i = readList(lines, i, out)
      continue
    }

    if (DEFINITION.test(lines[i + 1] ?? "")) {
      i = readDefinitions(lines, i, out)
      continue
    }

    if (SETEXT.test(lines[i + 1] ?? "")) {
      out.push({ kind: "h", level: 2, text: line.trim() })
      i += 2
      continue
    }

    i = readParagraph(lines, i, out)
  }

  return out
}

/** True when this line has to end the paragraph above it. */
function startsBlock(lines: string[], at: number): boolean {
  const line = lines[at]!
  if (line.trim() === "") return true
  if (FENCE.test(line)) return true
  if (HEADING.test(line)) return true
  if (RULE.test(line)) return true
  if (QUOTE.test(line)) return true
  if (BULLET.test(line) || ORDERED.test(line)) return true
  if (FOOTNOTE.test(line)) return true
  if (DEFINITION.test(line)) return true
  return readTable(lines, at) !== null
}

function readFence(
  lines: string[],
  from: number,
  opening: RegExpExecArray,
  out: Block[],
): number {
  // A tool result routinely contains a ``` line of its own; closing on the
  // first one would spill the rest of the output into the transcript as
  // prose. Only a fence at least as long as the opener ends the block.
  const fence = opening[1]!
  const lang = opening[2]!.trim()
  const closes = (candidate: string) => {
    const m = FENCE.exec(candidate)
    return m !== null && m[1]!.length >= fence.length && m[2]!.trim() === ""
  }
  const buf: string[] = []
  let i = from + 1
  while (i < lines.length && !closes(lines[i]!)) {
    buf.push(lines[i]!)
    i += 1
  }
  i += 1
  const body = buf.join("\n")

  if (lang === "diff") {
    out.push({ kind: "diff", code: body })
  } else if (lang === "mermaid") {
    out.push({ kind: "mermaid", code: body })
  } else if (lang === "thinking" || lang === "reasoning") {
    out.push({ kind: "reasoning", text: body })
  } else if (lang.startsWith("tool-result:")) {
    const { meta, body: payload } = decodeToolCardMeta(body)
    out.push({
      kind: "tool",
      name: lang.slice("tool-result:".length) || "result",
      body: payload,
      meta,
      result: true,
    })
  } else if (lang.startsWith("tool:")) {
    const { meta, body: payload } = decodeToolCardMeta(body)
    const name = lang.slice(5) || "tool"
    // Plan tools carry steps in meta — surface as a checklist, not a tool run.
    if (meta.plan && meta.plan.length > 0) {
      out.push({ kind: "plan", name, body: payload, meta })
    } else {
      out.push({ kind: "tool", name, body: payload, meta })
    }
  } else {
    out.push({ kind: "code", lang, code: body })
  }
  return i
}

function readQuote(lines: string[], from: number, out: Block[]): number {
  const inner: string[] = []
  let i = from
  while (i < lines.length) {
    const quoted = QUOTE.exec(lines[i]!)
    if (quoted) {
      inner.push(quoted[1]!)
      i += 1
      continue
    }
    // A lazy continuation line belongs to the quote; a blank line ends it.
    if (lines[i]!.trim() === "" || startsBlock(lines, i)) break
    inner.push(lines[i]!)
    i += 1
  }
  out.push({ kind: "quote", blocks: parseLines(inner) })
  return i
}

function readList(lines: string[], from: number, out: Block[]): number {
  const ordered = ORDERED.test(lines[from]!)
  const raw: { indent: number; text: string }[] = []
  let start = 1
  let i = from

  while (i < lines.length) {
    const match = ordered ? ORDERED.exec(lines[i]!) : BULLET.exec(lines[i]!)
    if (!match) {
      // An indented follow-on line continues the item above it.
      const continuation = /^\s+\S/.test(lines[i] ?? "")
      if (continuation && raw.length > 0 && !startsBlock(lines, i)) {
        raw[raw.length - 1]!.text += ` ${lines[i]!.trim()}`
        i += 1
        continue
      }
      break
    }
    if (ordered && raw.length === 0) start = Number(match[2])
    raw.push({ indent: match[1]!.length, text: match[3]! })
    i += 1
  }

  const ranks = [...new Set(raw.map((item) => item.indent))].sort((a, b) => a - b)
  const items: ListItem[] = raw.map((item) => {
    const task = TASK.exec(item.text)
    return {
      text: task ? task[2]! : item.text,
      depth: Math.min(ranks.indexOf(item.indent), MAX_LIST_DEPTH),
      checked: task ? task[1]!.toLowerCase() === "x" : null,
    }
  })

  out.push(ordered ? { kind: "ol", start, items } : { kind: "ul", items })
  return i
}

function readDefinitions(lines: string[], from: number, out: Block[]): number {
  const items: DefinitionItem[] = []
  let i = from
  while (i < lines.length) {
    const term = lines[i]!
    if (term.trim() === "" || !DEFINITION.test(lines[i + 1] ?? "")) break
    const details: string[] = []
    i += 1
    while (i < lines.length) {
      const detail = DEFINITION.exec(lines[i]!)
      if (!detail) break
      details.push(detail[1]!)
      i += 1
    }
    items.push({ term: term.trim(), details })
    if (lines[i]?.trim() === "") i += 1
  }
  out.push({ kind: "dl", items })
  return i
}

function readFootnotes(lines: string[], from: number, out: Block[]): number {
  const items: FootnoteItem[] = []
  let i = from
  while (i < lines.length) {
    const note = FOOTNOTE.exec(lines[i]!)
    if (!note) {
      if (lines[i]!.trim() === "" && FOOTNOTE.test(lines[i + 1] ?? "")) {
        i += 1
        continue
      }
      break
    }
    const parts = [note[2]!]
    i += 1
    while (i < lines.length && /^\s{2,}\S/.test(lines[i]!)) {
      parts.push(lines[i]!.trim())
      i += 1
    }
    items.push({ label: note[1]!, text: parts.join(" ").trim() })
  }
  out.push({ kind: "footnotes", items })
  return i
}

/**
 * Numbering for a flattened ordered list: a nested run restarts at 1 and the
 * level above it keeps counting where it left off.
 */
export function orderedMarkers(items: ListItem[], start: number): number[] {
  const counters: number[] = []
  const out: number[] = []
  for (const item of items) {
    counters.length = item.depth + 1
    for (let depth = 0; depth <= item.depth; depth += 1) {
      if (counters[depth] === undefined) counters[depth] = depth === 0 ? start : 1
    }
    out.push(counters[item.depth]!)
    counters[item.depth] = counters[item.depth]! + 1
  }
  return out
}

function readParagraph(lines: string[], from: number, out: Block[]): number {
  const buf = [lines[from]!]
  let i = from + 1
  while (i < lines.length && !startsBlock(lines, i) && !SETEXT.test(lines[i]!)) {
    buf.push(lines[i]!)
    i += 1
  }
  out.push({ kind: "p", text: buf.join("\n") })
  return i
}

/**
 * A tool call, the diff it produced and the output it came back with are one
 * event — see `lib/tool-runs`, which pairs them into a single card and groups
 * consecutive calls into one "Ran N commands" block.
 */
