import { orderedMarkers, type Block, type ListItem } from "./markdown"
import { tableToMarkdown } from "./markdown-table"
import { buildTranscript, type TranscriptBlock } from "./tool-runs"

const INDENT = "  "

type AnyBlock = Block | TranscriptBlock

/**
 * Markdown a human would want on the clipboard: the answer, its tables, code
 * and diagrams — with each tool call kept as one audit line and the model's
 * private reasoning dropped.
 */
export function blocksToPlainText(blocks: AnyBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    const text = blockToPlainText(block)
    if (text !== null && text !== "") parts.push(text)
  }
  return `${parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim()}\n`
}

/** The whole assistant message, straight from the markdown the adapters emit. */
export function messageToPlainText(src: string): string {
  return blocksToPlainText(buildTranscript(src).blocks)
}

export function blockToPlainText(block: AnyBlock): string | null {
  switch (block.kind) {
    case "h":
      return `${"#".repeat(block.level)} ${block.text}`
    case "p":
      return block.text
    case "hr":
      return "---"
    case "ul":
      return block.items.map((item) => bullet(item, "-")).join("\n")
    case "ol": {
      const markers = orderedMarkers(block.items, block.start)
      return block.items
        .map((item, i) => bullet(item, `${markers[i]}.`))
        .join("\n")
    }
    case "table":
      return tableToMarkdown(block.table)
    case "quote":
      return quote(blocksToPlainText(block.blocks))
    case "dl":
      return block.items
        .map((item) =>
          [item.term, ...item.details.map((d) => `${INDENT}: ${d}`)].join("\n"),
        )
        .join("\n")
    case "footnotes":
      return block.items.map((item) => `[^${item.label}]: ${item.text}`).join("\n")
    case "code":
      return fence(block.lang, block.code)
    case "mermaid":
      return fence("mermaid", block.code)
    case "diff":
      return fence("diff", block.code)
    case "plan":
      return (block.meta.plan ?? [])
        .map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.text}`)
        .join("\n")
    case "tools":
      return block.calls.map((call) => `· ${call.title}`).join("\n")
    case "tool":
      return block.result === true ? null : `· ${block.meta.desc ?? block.name}`
    case "reasoning":
      return null
    default:
      return null
  }
}

function bullet(item: ListItem, marker: string): string {
  const box = item.checked === null ? "" : `[${item.checked ? "x" : " "}] `
  return `${INDENT.repeat(item.depth)}${marker} ${box}${item.text}`
}

function quote(text: string): string {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n")
}

function fence(lang: string, code: string): string {
  // A body that already fences has to be wrapped in a longer fence or the
  // pasted markdown closes early.
  const runs = [...code.matchAll(/^`{3,}/gm)].map((m) => m[0].length)
  const bars = "`".repeat(Math.max(3, ...runs.map((n) => n + 1)))
  return `${bars}${lang}\n${code}\n${bars}`
}
