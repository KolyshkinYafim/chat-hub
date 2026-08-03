import type { ToolCardMeta } from "@shared/tool-card"
import { splitBlocks, type Block } from "./markdown"

export type ToolResult = {
  text: string
  error: boolean
  exitCode?: number
}

export type ToolCall = {
  key: string
  name: string
  args: string
  title: string
  meta: ToolCardMeta
  diff: string | null
  result: ToolResult | null
}

export type ToolRunBlock = { kind: "tools"; calls: ToolCall[] }

export type TranscriptBlock = Exclude<Block, { kind: "tool" }> | ToolRunBlock

export type ChangedFile = {
  path: string
  added?: number
  removed?: number
}

export type ChangedFiles = {
  files: ChangedFile[]
  added: number
  removed: number
  countsKnown: boolean
}

export type Transcript = {
  blocks: TranscriptBlock[]
  changed: ChangedFiles
}

const OUTPUT_HEAD_LINES = 6
const OUTPUT_COLLAPSE_OVER = 12
const TITLE_MAX = 140

export function buildTranscript(src: string, scope = ""): Transcript {
  const blocks = pairToolBlocks(splitBlocks(src), scope)
  return { blocks, changed: changedFiles(blocks) }
}

function pairToolBlocks(blocks: Block[], scope: string): TranscriptBlock[] {
  const out: TranscriptBlock[] = []
  const byId = new Map<string, ToolCall>()
  const calls: ToolCall[] = []
  let run: ToolRunBlock | null = null
  let lastCall: ToolCall | null = null
  let index = 0

  const startRun = () => {
    if (run) return run
    run = { kind: "tools", calls: [] }
    out.push(run)
    return run
  }

  for (const block of blocks) {
    if (block.kind === "tool" && !block.result) {
      const call = makeCall(block, index++, scope)
      calls.push(call)
      if (call.meta.id) byId.set(call.meta.id, call)
      startRun().calls.push(call)
      lastCall = call
      continue
    }

    if (block.kind === "tool") {
      const target = resultTarget(block.meta, byId, calls)
      if (target) {
        target.result = toResult(block)
        continue
      }
      startRun().calls.push(orphanResult(block, index++, scope))
      continue
    }

    if (block.kind === "diff" && lastCall && lastCall.diff === null) {
      lastCall.diff = block.code
      continue
    }

    run = null
    lastCall = null
    out.push(block)
  }

  return out
}

function resultTarget(
  meta: ToolCardMeta,
  byId: Map<string, ToolCall>,
  calls: ToolCall[],
): ToolCall | null {
  if (meta.id) {
    const exact = byId.get(meta.id)
    if (exact) return exact
  }
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]!
    if (call.result === null) return call
  }
  return null
}

function toResult(block: Extract<Block, { kind: "tool" }>): ToolResult {
  const exitCode = block.meta.exitCode
  return {
    text: block.body,
    error: block.meta.error === true || (exitCode !== undefined && exitCode !== 0),
    exitCode,
  }
}

function cardKey(scope: string, id: string | undefined, fallback: string): string {
  return `${scope}/${id ?? fallback}`
}

function makeCall(
  block: Extract<Block, { kind: "tool" }>,
  index: number,
  scope: string,
): ToolCall {
  return {
    key: cardKey(scope, block.meta.id, `b${index}`),
    name: block.name,
    args: block.body,
    title: describeCall(block.name, block.body, block.meta),
    meta: block.meta,
    diff: null,
    result: null,
  }
}

function orphanResult(
  block: Extract<Block, { kind: "tool" }>,
  index: number,
  scope: string,
): ToolCall {
  return {
    key: cardKey(scope, block.meta.id, `r${index}`),
    name: block.name,
    args: "",
    title: block.meta.desc ?? block.name,
    meta: block.meta,
    diff: null,
    result: toResult(block),
  }
}

export function isFailed(call: ToolCall): boolean {
  return call.result?.error === true
}

export function startsOpen(call: ToolCall): boolean {
  return isFailed(call) || call.diff !== null
}

export function isEditTool(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === "edit" ||
    lower === "write" ||
    lower === "multiedit" ||
    lower.includes("str_replace")
  )
}

export function describeCall(
  name: string,
  args: string,
  meta: ToolCardMeta,
): string {
  const lower = name.toLowerCase()
  if (meta.desc) {
    return clamp(`${meta.desc}${isEditTool(lower) ? delta(meta) : ""}`)
  }
  const head = firstLine(args)
  const path = meta.paths?.[0] ?? head

  if (lower === "bash") return clamp(`$ ${unwrapShell(head.replace(/^\$ /, ""))}`)
  if (lower === "read") return clamp(`Read ${baseName(path)}`)
  if (lower === "write") return clamp(`Wrote ${baseName(path)}${delta(meta)}`)
  if (lower === "edit" || lower === "multiedit" || lower.includes("str_replace")) {
    return clamp(`Edited ${baseName(path)}${delta(meta)}`)
  }
  if (lower === "grep") return clamp(`Grep ${head.replace(/^pattern: /, "")}`)
  if (lower === "glob") return clamp(head.replace(/^glob: /, "Glob "))
  if (lower === "websearch") return clamp(`Search ${head.replace(/^pattern: /, "")}`)
  if (lower === "task") return clamp(`Task ${head}`)
  if (!head || head === "(no args)") return clamp(name)
  return clamp(`${name} ${head}`)
}

function delta(meta: ToolCardMeta): string {
  const added = meta.added ?? 0
  const removed = meta.removed ?? 0
  if (added === 0 && removed === 0) return ""
  return ` +${added} −${removed}`
}

const SHELL_WRAP =
  /^\S*\b(?:bash|zsh|sh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/

function unwrapShell(command: string): string {
  const wrapped = SHELL_WRAP.exec(command.trim())
  return wrapped ? wrapped[2]!.trim() : command
}

function baseName(path: string): string {
  const clean = path.split(" · ")[0]!.trim()
  const parts = clean.split("/")
  return parts[parts.length - 1] || clean
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? ""
}

function clamp(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat
}

export function collapseOutput(text: string): {
  head: string
  hidden: number
} {
  const lines = text.split("\n")
  if (lines.length <= OUTPUT_COLLAPSE_OVER) return { head: text, hidden: 0 }
  return {
    head: lines.slice(0, OUTPUT_HEAD_LINES).join("\n"),
    hidden: lines.length - OUTPUT_HEAD_LINES,
  }
}

export function changedFiles(blocks: TranscriptBlock[]): ChangedFiles {
  const order: string[] = []
  const byPath = new Map<string, ChangedFile>()

  for (const block of blocks) {
    if (block.kind !== "tools") continue
    for (const call of block.calls) {
      const paths = call.meta.paths
      if (!paths || paths.length === 0) continue
      if (isFailed(call)) continue
      for (const path of paths) {
        const known = byPath.get(path)
        const entry = known ?? { path }
        if (!known) {
          order.push(path)
          byPath.set(path, entry)
        }
        if (paths.length === 1 && typeof call.meta.added === "number") {
          entry.added = (entry.added ?? 0) + call.meta.added
          entry.removed = (entry.removed ?? 0) + (call.meta.removed ?? 0)
        }
      }
    }
  }

  const files = order.map((path) => byPath.get(path)!)
  const countsKnown =
    files.length > 0 && files.every((f) => typeof f.added === "number")
  return {
    files,
    added: files.reduce((sum, f) => sum + (f.added ?? 0), 0),
    removed: files.reduce((sum, f) => sum + (f.removed ?? 0), 0),
    countsKnown,
  }
}
