import type { ReactNode } from "react"

/** Lightweight agent-transcript renderer (headings, lists, code, bold, tables-ish). */
export function MarkdownBody({
  text,
  streaming,
}: {
  text: string
  streaming?: boolean
}) {
  const blocks = splitBlocks(text)

  return (
    <div className={`md-body ${streaming ? "streaming" : ""}`}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
      {streaming ? <span className="caret" aria-hidden /> : null}
    </div>
  )
}

type Block =
  | { kind: "h"; level: 2 | 3; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "p"; text: string }

function splitBlocks(src: string): Block[] {
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
      out.push({ kind: "code", lang, code: buf.join("\n") })
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
      while (i < lines.length && /^\s*([-*]|\u2705)\s+/.test(lines[i]!)) {
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

function Block({ block }: { block: Block }) {
  if (block.kind === "h") {
    const Tag = block.level === 2 ? "h2" : "h3"
    return (
      <Tag className={`md-h md-h${block.level}`}>
        <Inline text={block.text} />
      </Tag>
    )
  }
  if (block.kind === "ul") {
    return (
      <ul className="md-ul">
        {block.items.map((item, i) => (
          <li key={i}>
            <Inline text={item} />
          </li>
        ))}
      </ul>
    )
  }
  if (block.kind === "code") {
    return (
      <pre className="md-code">
        {block.lang ? <span className="md-code-lang">{block.lang}</span> : null}
        <code>{block.code}</code>
      </pre>
    )
  }
  return (
    <p className="md-p">
      <Inline text={block.text} />
    </p>
  )
}

function Inline({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index))
    }
    const token = m[0]!
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={key++}>{token.slice(2, -2)}</strong>,
      )
    } else {
      nodes.push(
        <code key={key++} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      )
    }
    last = m.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}
