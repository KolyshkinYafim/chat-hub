import { createContext, useContext, useMemo, type ReactNode } from "react"
import { isSafeHttpUrl, linkDisplay } from "../lib/links"
import { parseInline, type InlineToken } from "../lib/markdown-inline"

/** Returns a click handler when the app can actually open that path, else null. */
export type PathOpener = (path: string) => (() => void) | null

export const PathActions = createContext<PathOpener | null>(null)

export function InlineText({ text }: { text: string }) {
  const tokens = useMemo(() => parseInline(text), [text])
  return <Tokens tokens={tokens} />
}

function Tokens({ tokens }: { tokens: InlineToken[] }) {
  return (
    <>
      {tokens.map((token, i) => (
        <Token key={i} token={token} />
      ))}
    </>
  )
}

function Token({ token }: { token: InlineToken }): ReactNode {
  switch (token.kind) {
    case "text":
      return token.text
    case "code":
      return <InlineCode text={token.text} role={token.role} />
    case "strong":
      return (
        <strong>
          <Tokens tokens={token.children} />
        </strong>
      )
    case "em":
      return (
        <em>
          <Tokens tokens={token.children} />
        </em>
      )
    case "strike":
      return (
        <s className="md-strike">
          <Tokens tokens={token.children} />
        </s>
      )
    case "link":
      return (
        <InlineLink url={token.url}>
          {token.children.length === 0 ? null : <Tokens tokens={token.children} />}
        </InlineLink>
      )
    case "autolink":
      return <InlineLink url={token.url}>{null}</InlineLink>
    case "image":
      return <ImageRef url={token.url} alt={token.alt} />
    case "footnote":
      return (
        <sup className="md-fnref" title={`Footnote ${token.label}`}>
          {token.label}
        </sup>
      )
    default:
      return null
  }
}

function InlineCode({ text, role }: { text: string; role: string }) {
  if (role === "kbd") return <kbd className="md-kbd">{text}</kbd>
  if (role === "path") return <PathCode text={text} />
  return <code className="md-inline-code">{text}</code>
}

function PathCode({ text }: { text: string }) {
  const opener = useContext(PathActions)
  const open = opener ? opener(text) : null
  if (!open) {
    return (
      <code className="md-inline-code md-path" title={text}>
        {text}
      </code>
    )
  }
  return (
    <button
      type="button"
      className="md-inline-code md-path actionable"
      title={`${text} — open in the Diff panel`}
      onClick={open}
    >
      {text}
    </button>
  )
}

function ImageRef({ url, alt }: { url: string; alt: string }) {
  const label = alt.trim() || linkDisplay(url).label
  if (!isSafeHttpUrl(url)) return <span className="md-image-ref">{label}</span>
  return (
    <a className="md-image-ref" href={url} target="_blank" rel="noreferrer" title={url}>
      <span className="md-image-ico" aria-hidden>
        ▣
      </span>
      {label}
    </a>
  )
}

export function InlineLink({
  url,
  children,
}: {
  url: string
  /** Null for a bare url — the host and path become the label instead. */
  children: ReactNode
}) {
  if (!isSafeHttpUrl(url)) return <>{children ?? url}</>
  const display = linkDisplay(url)
  const fallback = display.hint
    ? `${display.host} · ${display.hint}`
    : `${display.host}${display.label === display.host ? "" : display.label}`
  return (
    <a className="md-link" href={url} target="_blank" rel="noreferrer" title={url}>
      {children ?? fallback}
      <span className="md-link-arrow" aria-hidden>
        ↗
      </span>
    </a>
  )
}
