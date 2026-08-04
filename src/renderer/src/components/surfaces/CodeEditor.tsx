import { useEffect, useRef } from "react"
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import {
  blockCommentStarts,
  highlightLine,
  type SyntaxClass,
} from "../../lib/syntax"

const MARKS: Record<SyntaxClass, Decoration> = {
  plain: Decoration.mark({ class: "tok-plain" }),
  keyword: Decoration.mark({ class: "tok-keyword" }),
  type: Decoration.mark({ class: "tok-type" }),
  string: Decoration.mark({ class: "tok-string" }),
  number: Decoration.mark({ class: "tok-number" }),
  comment: Decoration.mark({ class: "tok-comment" }),
  punct: Decoration.mark({ class: "tok-punct" }),
}

function buildDecorations(
  view: EditorView,
  language: string,
  opensAt: boolean[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const range of view.visibleRanges) {
    let pos = range.from
    while (pos <= range.to) {
      const line = view.state.doc.lineAt(pos)
      const { spans } = highlightLine(
        line.text,
        language,
        opensAt[line.number - 1] ?? false,
      )
      for (const span of spans) {
        const end = Math.min(span.end, line.length)
        if (end <= span.start) continue
        builder.add(line.from + span.start, line.from + end, MARKS[span.cls])
      }
      if (line.to >= view.state.doc.length) break
      pos = line.to + 1
    }
  }
  return builder.finish()
}

function sharedHighlighter(language: string): Extension {
  return ViewPlugin.fromClass(
    class {
      opensAt: boolean[]
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.opensAt = blockCommentStarts(view.state.doc.toString(), language)
        this.decorations = buildDecorations(view, language, this.opensAt)
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.opensAt = blockCommentStarts(
            update.state.doc.toString(),
            language,
          )
        }
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(
            update.view,
            language,
            this.opensAt,
          )
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}

type Props = {
  doc: string
  language: string
  readOnly: boolean
  onChange: (next: string) => void
  onSave: () => void
}

export function CodeEditor({
  doc,
  language,
  readOnly,
  onChange,
  onSave,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const changeRef = useRef(onChange)
  const saveRef = useRef(onSave)
  const docRef = useRef(doc)

  useEffect(() => {
    changeRef.current = onChange
    saveRef.current = onSave
  }, [onChange, onSave])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: docRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          EditorView.lineWrapping,
          sharedHighlighter(language),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                saveRef.current()
                return true
              },
            },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const next = update.state.doc.toString()
            docRef.current = next
            changeRef.current(next)
          }),
        ],
      }),
    })

    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [language, readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view || doc === view.state.doc.toString()) return
    docRef.current = doc
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
    })
  }, [doc])

  return <div className="code-editor" ref={hostRef} />
}
