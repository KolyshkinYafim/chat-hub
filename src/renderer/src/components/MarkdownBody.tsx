import { Fragment, useMemo, type ReactNode } from "react"
import { buildTranscript, type TranscriptBlock } from "../lib/tool-runs"
import { isBareUrlParagraph, linkDisplay } from "../lib/links"
import { orderedMarkers, type Block as MdBlock, type ListItem } from "../lib/markdown"
import { matchPath } from "../lib/path-match"
import { ChangedFiles } from "./ChangedFiles"
import { CodeBlock } from "./CodeBlock"
import { DataTable } from "./DataTable"
import { DiffBody } from "./DiffBody"
import { InlineText, PathActions, type PathOpener } from "./InlineText"
import { MermaidDiagram } from "./MermaidDiagram"
import { PlanSteps } from "./PlanSteps"
import { ToolRun } from "./ToolRun"

type AnyBlock = TranscriptBlock | MdBlock

/** Lightweight agent-transcript renderer (headings, lists, tables, code, tool runs). */
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
  const { blocks, changed } = useMemo(
    () => buildTranscript(text, messageId),
    [text, messageId],
  )
  const files = changed.files

  // A path in prose is only worth a click when this turn actually touched it —
  // anything else would open the Diff panel on a file that is not in the diff.
  const openPath = useMemo<PathOpener | null>(() => {
    if (!onOpenDiff) return null
    return (path) => {
      const hit = matchPath(files, (file) => file.path, path)
      return hit ? () => onOpenDiff(hit.path) : null
    }
  }, [files, onOpenDiff])

  return (
    <PathActions.Provider value={openPath}>
      <div className={`md-body ${streaming ? "streaming" : ""}`}>
        {blocks.map((block, i) => (
          <Block
            key={i}
            block={block}
            live={streaming === true}
            scope={`${messageId ?? ""}/b${i}`}
          />
        ))}
        {streaming ? null : (
          <ChangedFiles changed={changed} cwd={cwd} onOpenDiff={onOpenDiff} />
        )}
      </div>
    </PathActions.Provider>
  )
}

function Block({
  block,
  live,
  scope,
}: {
  block: AnyBlock
  live: boolean
  scope: string
}): ReactNode {
  switch (block.kind) {
    case "tools":
      return <ToolRun calls={block.calls} live={live} />
    case "plan":
      return (
        <PlanSteps
          steps={block.meta.plan ?? []}
          title={"title" in block ? block.title : block.name}
          toolName={block.name}
          expandKey={"key" in block ? block.key : scope}
        />
      )
    case "h":
      return <Heading level={block.level} text={block.text} />
    case "ul":
      return (
        <ul className="md-ul">
          {block.items.map((item, i) => (
            <Item key={i} item={item} marker={BULLETS[item.depth % BULLETS.length]!} />
          ))}
        </ul>
      )
    case "ol":
      return <OrderedList items={block.items} start={block.start} />
    case "table":
      return <DataTable table={block.table} expandKey={scope} />
    case "quote":
      return (
        <blockquote className="md-quote">
          {block.blocks
            .filter((child) => child.kind !== "tool" && child.kind !== "plan")
            .map((child, i) => (
              <Block key={i} block={child} live={live} scope={`${scope}q${i}`} />
            ))}
        </blockquote>
      )
    case "hr":
      return <hr className="md-hr" />
    case "dl":
      return (
        <dl className="md-dl">
          {block.items.map((item, i) => (
            <Fragment key={i}>
              <dt>
                <InlineText text={item.term} />
              </dt>
              {item.details.map((detail, j) => (
                <dd key={j}>
                  <InlineText text={detail} />
                </dd>
              ))}
            </Fragment>
          ))}
        </dl>
      )
    case "footnotes":
      return (
        <ol className="md-footnotes">
          {block.items.map((item) => (
            <li key={item.label}>
              <span className="md-fn-label">{item.label}</span>
              <InlineText text={item.text} />
            </li>
          ))}
        </ol>
      )
    case "code":
      return <CodeBlock lang={block.lang} code={block.code} expandKey={scope} />
    case "mermaid":
      // Partial stream chunks are invalid mermaid — show raw source until final.
      return live ? (
        <CodeBlock lang="mermaid" code={block.code} expandKey={scope} />
      ) : (
        <MermaidDiagram code={block.code} />
      )
    case "diff":
      return <DiffBody code={block.code} />
    case "reasoning":
      return (
        <details className="md-reasoning">
          <summary>
            <span className="reasoning-ico">🧠</span> Reasoning
          </summary>
          <div className="reasoning-body">{block.text}</div>
        </details>
      )
    case "tool":
      return <CodeBlock lang={block.name} code={block.body} expandKey={scope} />
    default:
      return <Paragraph text={block.text} />
  }
}

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const
const BULLETS = ["•", "◦", "▪"] as const

function Heading({ level, text }: { level: number; text: string }) {
  const Tag = HEADING_TAGS[level - 1] ?? "h3"
  return (
    <Tag className={`md-h md-h${level}`}>
      <InlineText text={text} />
    </Tag>
  )
}

function OrderedList({ items, start }: { items: ListItem[]; start: number }) {
  const markers = useMemo(() => orderedMarkers(items, start), [items, start])
  return (
    <ol className="md-ol" start={start}>
      {items.map((item, i) => (
        <Item key={i} item={item} marker={`${markers[i]}.`} />
      ))}
    </ol>
  )
}

function Item({ item, marker }: { item: ListItem; marker: string | null }) {
  const task = item.checked !== null
  return (
    <li
      className={`md-li md-d${item.depth}${task ? " task" : ""}${
        item.checked ? " done" : ""
      }`}
    >
      {task ? (
        <span className="md-check" aria-hidden>
          {item.checked ? "✓" : ""}
        </span>
      ) : (
        <span className="md-marker" aria-hidden>
          {marker}
        </span>
      )}
      <span className="md-li-text">
        <InlineText text={item.text} />
      </span>
    </li>
  )
}

function Paragraph({ text }: { text: string }) {
  const bareUrl = isBareUrlParagraph(text)
  if (bareUrl) return <LinkCard url={bareUrl} />
  const lines = text.split("\n")
  return (
    <p className="md-p">
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? <br /> : null}
          <InlineText text={line} />
        </Fragment>
      ))}
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
