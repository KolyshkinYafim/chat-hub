import type { ReactNode } from "react"
import { parseTranscript, type Block as TranscriptBlock } from "../lib/markdown"

/** Lightweight agent-transcript renderer (headings, lists, code, bold, tables-ish). */
export function MarkdownBody({
  text,
  streaming,
}: {
  text: string
  streaming?: boolean
}) {
  const blocks = parseTranscript(text)

  return (
    <div className={`md-body ${streaming ? "streaming" : ""}`}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  )
}

function Block({ block }: { block: TranscriptBlock }) {
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
  if (block.kind === "diff") {
    const lines = block.code.split("\n")
    const added = lines.filter((l) => l.startsWith("+")).length
    const removed = lines.filter((l) => l.startsWith("-")).length
    return (
      <div className="md-diff">
        <div className="md-diff-head">
          <span className="diff-ico">±</span>
          <span className="diff-stat add">+{added}</span>
          <span className="diff-stat del">−{removed}</span>
        </div>
        <pre>
          <code>
            {lines.map((l, i) => {
              const cls = l.startsWith("+")
                ? "add"
                : l.startsWith("-")
                  ? "del"
                  : "ctx"
              return (
                <span key={i} className={`diff-line ${cls}`}>
                  {l || " "}
                  {"\n"}
                </span>
              )
            })}
          </code>
        </pre>
      </div>
    )
  }
  if (block.kind === "reasoning") {
    return (
      <details className="md-reasoning" open>
        <summary>
          <span className="reasoning-ico">🧠</span> Reasoning
        </summary>
        <div className="reasoning-body">{block.text}</div>
      </details>
    )
  }
  if (block.kind === "tool") {
    return (
      <div className={`tool-card ${block.result ? "result" : "call"}`}>
        <div className="tool-card-head">
          <span className="tool-ico">{block.result ? "↓" : "⚙"}</span>
          {block.desc ? (
            <span className="tool-desc">{block.desc}</span>
          ) : (
            <span className="tool-name">{block.name}</span>
          )}
          <span className="tool-kind">{block.desc ? block.name : block.result ? "result" : "tool"}</span>
        </div>
        {block.body ? (
          <pre className="tool-body">
            <code>{block.body}</code>
          </pre>
        ) : null}
        {block.attached?.map((part, i) => (
          <div key={i} className="tool-card-part">
            <Block block={part} />
          </div>
        ))}
      </div>
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
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
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
