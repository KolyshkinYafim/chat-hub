import type { ReactNode } from "react"
import { buildTranscript, type TranscriptBlock } from "../lib/tool-runs"
import {
  isBareUrlParagraph,
  isSafeHttpUrl,
  linkDisplay,
  trimTrailingPunctuation,
  URL_PATTERN,
} from "../lib/links"
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
  const bareUrl = isBareUrlParagraph(block.text)
  if (bareUrl) return <LinkCard url={bareUrl} />
  return (
    <p className="md-p">
      <Inline text={block.text} />
    </p>
  )
}

function LinkCard({ url }: { url: string }) {
  const { host, label, hint } = linkDisplay(url)
  return (
    <a
      className="md-link-card"
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
    >
      <span className="md-link-globe" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <ellipse cx="7" cy="7" rx="2.4" ry="5.5" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M1.8 7h10.4M2.6 4.2h8.8M2.6 9.8h8.8" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </span>
      <span className="md-link-host">{host}</span>
      {hint ? <span className="md-link-hint">{hint}</span> : null}
      <span className="md-link-path">{label}</span>
      <span className="md-link-arrow" aria-hidden>
        ↗
      </span>
    </a>
  )
}

function InlineLink({ url, label }: { url: string; label: string | null }) {
  if (!isSafeHttpUrl(url)) return <>{label ?? url}</>
  const display = linkDisplay(url)
  return (
    <a
      className="md-link"
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
    >
      {label ?? (display.hint ? `${display.host} · ${display.hint}` : `${display.host}${display.label === display.host ? "" : display.label}`)}
      <span className="md-link-arrow" aria-hidden>
        ↗
      </span>
    </a>
  )
}

function Inline({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  const re = new RegExp(
    `(\\*\\*[^*]+\\*\\*|\`[^\`]+\`|\\[[^\\]]+\\]\\(https?:\\/\\/[^\\s)]+\\)|${URL_PATTERN.source})`,
    "g",
  )
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
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={key++} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](")
      nodes.push(
        <InlineLink
          key={key++}
          url={trimTrailingPunctuation(token.slice(split + 2, -1))}
          label={token.slice(1, split)}
        />,
      )
    } else {
      nodes.push(<InlineLink key={key++} url={token} label={null} />)
    }
    last = m.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}
