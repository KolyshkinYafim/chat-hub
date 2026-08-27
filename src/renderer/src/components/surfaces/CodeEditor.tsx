import { useEffect, useRef } from "react"
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state"
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

const revealLine = StateEffect.define<number | null>()

const REVEAL_DECORATION = Decoration.line({ class: "cm-reveal-line" })

const revealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(revealLine)) continue
      next =
        effect.value === null
          ? Decoration.none
          : Decoration.set([
              REVEAL_DECORATION.range(tr.state.doc.line(effect.value).from),
            ])
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

const REVEAL_FADE_MS = 1600

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
  focusLine?: { line: number; at: number } | null
  onChange: (next: string) => void
  onSave: () => void
}

export function CodeEditor({
  doc,
  language,
  readOnly,
  focusLine = null,
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
          revealField,
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

  useEffect(() => {
    const view = viewRef.current
    if (!view || !focusLine) return
    const lineNo = Math.max(
      1,
      Math.min(Math.round(focusLine.line), view.state.doc.lines),
    )
    const line = view.state.doc.line(lineNo)
    view.dispatch({
      selection: { anchor: line.from },
      effects: [
        revealLine.of(lineNo),
        EditorView.scrollIntoView(line.from, { y: "center" }),
      ],
    })
    const timer = window.setTimeout(() => {
      viewRef.current?.dispatch({ effects: revealLine.of(null) })
    }, REVEAL_FADE_MS)
    return () => window.clearTimeout(timer)
    // `at` is the request nonce — one reveal per request. Depending on the
    // object would re-scroll and re-flash the line while it is being read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLine?.at])

  return <div className="code-editor" ref={hostRef} />
}
