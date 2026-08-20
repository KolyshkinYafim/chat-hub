import { useMemo } from "react"
import { useExpanded } from "../lib/expansion"
import { languageOfTag, styleBlock } from "../lib/syntax"
import { CopyButton } from "./CopyButton"

const COLLAPSE_OVER = 30
const HEAD_LINES = 16

export function CodeBlock({
  lang,
  code,
  expandKey,
}: {
  lang: string
  code: string
  /** Scopes the remembered "show more" state to this block of this message. */
  expandKey: string
}) {
  const language = useMemo(() => languageOfTag(lang), [lang])
  const lines = useMemo(() => styleBlock(code, language), [code, language])
  const long = lines.length > COLLAPSE_OVER
  const [open, toggle] = useExpanded(`${expandKey}:code`, false)
  const shown = long && !open ? lines.slice(0, HEAD_LINES) : lines
  const hidden = lines.length - shown.length

  return (
    <div className={`md-block md-code-block ${long && !open ? "clipped" : ""}`}>
      <div className="md-block-bar">
        <span className="md-block-tag">{lang || language}</span>
        <span className="md-block-actions">
          <CopyButton text={() => code} title="Copy the code" />
        </span>
      </div>
      <pre className="md-code">
        <code>
          {shown.map((pieces, i) => (
            <span key={i} className="md-code-line">
              {pieces.length === 0
                ? " "
                : pieces.map((piece, j) => (
                    <span key={j} className={`tok-${piece.cls}`}>
                      {piece.text}
                    </span>
                  ))}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
      {long ? (
        <button type="button" className="md-more" onClick={toggle}>
          {open ? "Show less" : `${hidden} more lines`}
        </button>
      ) : null}
    </div>
  )
}
