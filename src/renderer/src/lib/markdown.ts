import { decodeToolCardMeta, type ToolCardMeta } from "@shared/tool-card"

/** Block model for the agent-transcript renderer (see MarkdownBody). */
export type Block =
  | { kind: "h"; level: 2 | 3; text: string }
  | { kind: "ul"; items: string[] }
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

export function splitBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const opening = FENCE.exec(line)

    if (opening) {
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
      i += 1
      while (i < lines.length && !closes(lines[i]!)) {
        buf.push(lines[i]!)
        i += 1
      }
      i += 1
      if (lang === "diff") {
        out.push({ kind: "diff", code: buf.join("\n") })
      } else if (lang === "mermaid") {
        out.push({ kind: "mermaid", code: buf.join("\n") })
      } else if (lang === "thinking" || lang === "reasoning") {
        out.push({ kind: "reasoning", text: buf.join("\n") })
      } else if (lang.startsWith("tool-result:")) {
        const { meta, body } = decodeToolCardMeta(buf.join("\n"))
        out.push({
          kind: "tool",
          name: lang.slice("tool-result:".length) || "result",
          body,
          meta,
          result: true,
        })
      } else if (lang.startsWith("tool:")) {
        const { meta, body } = decodeToolCardMeta(buf.join("\n"))
        const name = lang.slice(5) || "tool"
        // Plan tools carry steps in meta — surface as a checklist, not a tool run.
        if (meta.plan && meta.plan.length > 0) {
          out.push({ kind: "plan", name, body, meta })
        } else {
          out.push({ kind: "tool", name, body, meta })
        }
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
 * A tool call, the diff it produced and the output it came back with are one
 * event — see `lib/tool-runs`, which pairs them into a single card and groups
 * consecutive calls into one "Ran N commands" block.
 */
