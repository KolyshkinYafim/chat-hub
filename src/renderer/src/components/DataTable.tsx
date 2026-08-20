import { useMemo } from "react"
import { useExpanded } from "../lib/expansion"
import {
  columnAlign,
  isNumericCell,
  tableToMarkdown,
  tableToTsv,
  type MarkdownTable,
} from "../lib/markdown-table"
import { CopyButton } from "./CopyButton"
import { InlineText } from "./InlineText"

const COLLAPSE_OVER = 18
const HEAD_ROWS = 10

export function DataTable({
  table,
  expandKey,
}: {
  table: MarkdownTable
  /** Scopes the remembered "show more" state to this block of this message. */
  expandKey: string
}) {
  const aligns = useMemo(
    () => table.head.map((_, i) => columnAlign(table, i)),
    [table],
  )
  const long = table.rows.length > COLLAPSE_OVER
  const [open, toggle] = useExpanded(`${expandKey}:table`, false)
  const rows = long && !open ? table.rows.slice(0, HEAD_ROWS) : table.rows
  const hidden = table.rows.length - rows.length

  return (
    <div className="md-block md-table-block">
      <div className="md-block-bar">
        <span
          className="md-block-tag"
          title={`${table.rows.length} rows × ${table.head.length} columns`}
        >
          {table.rows.length} × {table.head.length}
        </span>
        <span className="md-block-actions">
          <CopyButton
            label="md"
            title="Copy as a markdown table"
            text={() => tableToMarkdown(table)}
          />
          <CopyButton
            label="tsv"
            title="Copy as tab-separated values, for a spreadsheet"
            text={() => tableToTsv(table)}
          />
        </span>
      </div>
      {/* Focusable so a wide table can be scrolled from the keyboard. */}
      <div
        className="md-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={`Table, ${table.rows.length} rows`}
      >
        <table className="md-table">
          <thead>
            <tr>
              {table.head.map((cell, i) => (
                <th key={i} className={`align-${aligns[i]}`} scope="col">
                  <InlineText text={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className={`align-${aligns[c]}${
                      isNumericCell(cell) ? " numeric" : ""
                    }`}
                  >
                    <InlineText text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {long ? (
        <button type="button" className="md-more" onClick={toggle}>
          {open ? "Show less" : `${hidden} more rows`}
        </button>
      ) : null}
    </div>
  )
}
