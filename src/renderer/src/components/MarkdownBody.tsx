import type { ReactNode } from "react"
import { buildTranscript, type TranscriptBlock } from "../lib/tool-runs"
import { ChangedFiles } from "./ChangedFiles"
import { DiffBody } from "./DiffBody"
import { MermaidDiagram } from "./MermaidDiagram"
import { PlanSteps } from "./PlanSteps"
import { ToolRun } from "./ToolRun"

/** Lightweight agent-transcript renderer (headings, lists, code, tool runs). */
export function MarkdownBody({
  text,
  messageId,
  streaming,
  cwd,
  onOpenDiff,
}: {
  text: string
  /** Scopes each card's remembered expansion — CLIs reuse ids across turns. */
  messageId?: string
  streaming?: boolean
  cwd?: string
  onOpenDiff?: (path: string) => void
}) {
  const { blocks, changed } = buildTranscript(text, messageId)

  return (
    <div className={`md-body ${streaming ? "streaming" : ""}`}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} live={streaming === true} />
      ))}
      {streaming ? null : (
        <ChangedFiles changed={changed} cwd={cwd} onOpenDiff={onOpenDiff} />
      )}
    </div>
  )
}

function Block({ block, live }: { block: TranscriptBlock; live: boolean }) {
  if (block.kind === "tools") {
    return <ToolRun calls={block.calls} live={live} />
  }
  if (block.kind === "plan") {
    return (
      <PlanSteps
        steps={block.meta.plan ?? []}
        title={block.title}
        toolName={block.name}
        expandKey={block.key}
      />
    )
  }
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
  if (block.kind === "mermaid") {
    // Partial stream chunks are invalid mermaid — show raw code until final.
    if (live) {
      return (
        <pre className="md-code">
          <span className="md-code-lang">mermaid</span>
          <code>{block.code}</code>
        </pre>
      )
    }
    return <MermaidDiagram code={block.code} />
  }
  if (block.kind === "diff") {
    return <DiffBody code={block.code} />
  }
  if (block.kind === "reasoning") {
    return (
      <details className="md-reasoning">
        <summary>
          <span className="reasoning-ico">🧠</span> Reasoning
        </summary>
        <div className="reasoning-body">{block.text}</div>
      </details>
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
