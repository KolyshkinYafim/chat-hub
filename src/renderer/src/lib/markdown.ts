/** Block model for the agent-transcript renderer (see MarkdownBody). */
export type Block =
  | { kind: "h"; level: 2 | 3; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "diff"; code: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool"
      name: string
      body: string
      /** CLI-supplied one-line description (Claude's Bash tool sends one). */
      desc?: string
      result?: boolean
      /** Diff / result blocks that belong to this call, drawn inside its card. */
      attached?: Block[]
    }
  | { kind: "p"; text: string }

/**
 * A tool card's body may lead with a `\x1f`-marked description line (see
 * toolUseBlock). Peel it off so the card can title itself with the CLI's own
 * one-liner and keep the command/args as the body.
 */
function splitToolDesc(raw: string): { desc?: string; body: string } {
  if (!raw.startsWith("\x1f")) return { body: raw }
  const nl = raw.indexOf("\n")
  if (nl === -1) return { desc: raw.slice(1) || undefined, body: "" }
  return { desc: raw.slice(1, nl) || undefined, body: raw.slice(nl + 1) }
}

export function splitBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        buf.push(lines[i]!)
        i += 1
      }
      i += 1
      if (lang === "diff") {
        out.push({ kind: "diff", code: buf.join("\n") })
      } else if (lang === "thinking" || lang === "reasoning") {
        out.push({ kind: "reasoning", text: buf.join("\n") })
      } else if (lang.startsWith("tool-result:")) {
        const { desc, body } = splitToolDesc(buf.join("\n"))
        out.push({
          kind: "tool",
          name: lang.slice("tool-result:".length) || "result",
          body,
          desc,
          result: true,
        })
      } else if (lang.startsWith("tool:")) {
        const { desc, body } = splitToolDesc(buf.join("\n"))
        out.push({
          kind: "tool",
          name: lang.slice(5) || "tool",
          body,
          desc,
        })
      } else {
        out.push({ kind: "code", lang, code: buf.join("\n") })
      }
      continue
    }

    if (line.startsWith("### ")) {
      out.push({ kind: "h", level: 3, text: line.slice(4) })
      i += 1
      continue
    }
    if (line.startsWith("## ")) {
      out.push({ kind: "h", level: 2, text: line.slice(3) })
      i += 1
      continue
    }

    if (/^\s*[-*✅]\s+/.test(line) || /^\s*-\s+✅/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|✅)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, "").replace(/^\s*/, ""))
        i += 1
      }
      // also match lines starting with - ✅
      out.push({ kind: "ul", items })
      continue
    }

    if (line.trim() === "") {
      i += 1
      continue
    }

    const buf = [line]
    i += 1
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("##") &&
      !lines[i]!.startsWith("```") &&
      !/^\s*[-*✅]/.test(lines[i]!)
    ) {
      buf.push(lines[i]!)
      i += 1
    }
    out.push({ kind: "p", text: buf.join("\n") })
  }

  return out
}

/**
 * A tool call and the diff or result it produced are one event, so they become
 * one card with internal dividers — as two sibling boxes they read as two
 * things happening, which is the wrong story about the transcript.
 */
export function foldToolFollowUps(blocks: Block[]): Block[] {
  const out: Block[] = []
  for (const block of blocks) {
    const prev = out[out.length - 1]
    const followsCall =
      prev?.kind === "tool" &&
      !prev.result &&
      (block.kind === "diff" || (block.kind === "tool" && block.result === true))
    if (followsCall && prev?.kind === "tool") {
      out[out.length - 1] = {
        ...prev,
        attached: [...(prev.attached ?? []), block],
      }
      continue
    }
    out.push(block)
  }
  return out
}

export function parseTranscript(src: string): Block[] {
  return foldToolFollowUps(splitBlocks(src))
}
