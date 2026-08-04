import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent, ReactNode } from "react"
import { extensionOf } from "@shared/file-kind"
import { STALE_WRITE_MESSAGE } from "@shared/surfaces"
import { formatBytes } from "../../lib/format"
import { languageOf } from "../../lib/syntax"
import {
  errorText,
  surfaceBridge,
  type OpenedFile,
} from "../../lib/surface-bridge"
import { MarkdownBody } from "../MarkdownBody"
import { MermaidDiagram } from "../MermaidDiagram"
import { CodeEditor } from "./CodeEditor"
import { ImagePreview } from "./ImagePreview"
import { MediaPreview } from "./MediaPreview"

type Presentation =
  | "code"
  | "markdown"
  | "mermaid"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "binary"

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"])
const MERMAID_EXTENSIONS = new Set(["mmd", "mermaid"])

function presentationOf(file: OpenedFile): Presentation {
  if (file.kind !== "text") return file.kind
  const extension = extensionOf(file.path)
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown"
  if (MERMAID_EXTENSIONS.has(extension)) return "mermaid"
  return "code"
}

function isSvg(file: OpenedFile): boolean {
  return file.mime === "image/svg+xml"
}

function svgDataUrl(source: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
}

type Props = {
  cwd: string
  path: string
  onDirtyChange: (dirty: boolean) => void
}

export function FileViewer({ cwd, path, onDirtyChange }: Props) {
  const [file, setFile] = useState<OpenedFile | null>(null)
  const [draft, setDraft] = useState("")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const liveRef = useRef(true)

  useEffect(() => {
    liveRef.current = true
    return () => {
      liveRef.current = false
    }
  }, [])

  useEffect(() => {
    setFile(null)
    setDraft("")
    setLoadError(null)
    setSaveError(null)
    setConflict(false)
    setJustSaved(false)
    setShowSource(false)

    void (async () => {
      try {
        const opened = await surfaceBridge().openFile(cwd, path)
        if (!liveRef.current) return
        setFile(opened)
        setDraft(opened.text ?? "")
      } catch (err) {
        if (!liveRef.current) return
        setLoadError(errorText(err))
      }
    })()
  }, [cwd, path, reloadKey])

  const presentation = file ? presentationOf(file) : "code"
  const editable =
    file !== null && file.text !== null && !file.truncated && !conflict
  const dirty = file !== null && file.text !== null && draft !== file.text

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (!dirty) return
    setJustSaved(false)
  }, [dirty])

  const save = useCallback(async () => {
    if (!file || !editable || saving) return
    if (draft === file.text) return
    setSaving(true)
    try {
      const saved = await surfaceBridge().saveFile(cwd, path, draft, file.stamp)
      if (!liveRef.current) return
      setFile({ ...file, text: draft, stamp: saved.stamp, size: saved.stamp.size })
      setSaveError(null)
      setConflict(false)
      setJustSaved(true)
    } catch (err) {
      if (!liveRef.current) return
      const message = errorText(err)
      setConflict(message.includes(STALE_WRITE_MESSAGE))
      setSaveError(message)
    } finally {
      if (liveRef.current) setSaving(false)
    }
  }, [cwd, draft, editable, file, path, saving])

  const requestSave = useCallback(() => {
    void save()
  }, [save])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
      return
    }
    event.preventDefault()
    requestSave()
  }

  function openExternally() {
    if (file) void window.chatHub.openPath(file.absolutePath)
  }

  const language = useMemo(() => languageOf(path), [path])

  return (
    <div className="surface-viewer" onKeyDown={onKeyDown}>
      <div className="surface-viewer-head">
        <span className="mono-soft" title={path}>
          {path}
        </span>
        {file && presentationHasSource(presentation, file) ? (
          <button
            type="button"
            className={`file-toggle ${showSource ? "active" : ""}`}
            onClick={() => setShowSource((curr) => !curr)}
          >
            {showSource ? "Preview" : "Source"}
          </button>
        ) : null}
        {dirty ? <span className="file-dirty">Unsaved</span> : null}
        {justSaved && !dirty ? <span className="file-saved">Saved</span> : null}
        {file && editable ? (
          <button
            type="button"
            className="file-save"
            disabled={!dirty || saving}
            title="⌘S"
            onClick={requestSave}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        ) : null}
        {file && file.text !== null && file.truncated ? (
          <span className="surface-readonly">read-only</span>
        ) : null}
      </div>

      {conflict ? (
        <div className="file-conflict" role="alert">
          <span>{path} changed on disk since you opened it.</span>
          <button
            type="button"
            className="file-action"
            onClick={() => setReloadKey((curr) => curr + 1)}
          >
            Reload from disk
          </button>
        </div>
      ) : saveError ? (
        <p className="surface-note error">{saveError}</p>
      ) : null}

      {loadError ? (
        <p className="surface-note error">{loadError}</p>
      ) : !file ? (
        <p className="surface-note">Reading…</p>
      ) : (
        <>
          {file.truncated ? (
            <p className="surface-note truncated">
              Cut off at the read cap — editing is disabled so a save cannot
              drop the tail.
            </p>
          ) : null}
          <FileBody
            file={file}
            presentation={presentation}
            language={language}
            draft={draft}
            showSource={showSource}
            editable={editable}
            onDraftChange={setDraft}
            onSave={requestSave}
            onOpenExternally={openExternally}
          />
        </>
      )}
    </div>
  )
}

function presentationHasSource(
  presentation: Presentation,
  file: OpenedFile,
): boolean {
  if (presentation === "markdown" || presentation === "mermaid") return true
  return presentation === "image" && isSvg(file) && file.text !== null
}

type BodyProps = {
  file: OpenedFile
  presentation: Presentation
  language: string
  draft: string
  showSource: boolean
  editable: boolean
  onDraftChange: (next: string) => void
  onSave: () => void
  onOpenExternally: () => void
}

function FileBody({
  file,
  presentation,
  language,
  draft,
  showSource,
  editable,
  onDraftChange,
  onSave,
  onOpenExternally,
}: BodyProps) {
  const editor = (
    <CodeEditor
      doc={draft}
      language={language}
      readOnly={!editable}
      onChange={onDraftChange}
      onSave={onSave}
    />
  )

  if (presentation === "code") return editor

  if (presentation === "markdown") {
    const preview = <MarkdownBody text={draft} />
    return showSource ? (
      <SplitPane editor={editor} preview={preview} />
    ) : (
      <div className="file-rendered">{preview}</div>
    )
  }

  if (presentation === "mermaid") {
    const preview = <MermaidDiagram code={draft} />
    return showSource ? (
      <SplitPane editor={editor} preview={preview} />
    ) : (
      <div className="file-rendered">{preview}</div>
    )
  }

  if (presentation === "image") {
    if (isSvg(file) && showSource) {
      return (
        <SplitPane
          editor={editor}
          preview={
            <ImagePreview
              src={svgDataUrl(draft)}
              mime={file.mime}
              size={file.size}
              name={file.path}
            />
          }
        />
      )
    }
    if (!file.dataUrl) {
      return (
        <Refusal
          headline={file.unavailable ?? "This image could not be read."}
          file={file}
          onOpenExternally={onOpenExternally}
        />
      )
    }
    return (
      <div className="file-rendered">
        <ImagePreview
          src={file.dataUrl}
          mime={file.mime}
          size={file.size}
          name={file.path}
        />
      </div>
    )
  }

  if (presentation === "video" || presentation === "audio") {
    if (!file.streamUrl) {
      return (
        <Refusal
          headline={file.unavailable ?? "No player is available for this file."}
          file={file}
          onOpenExternally={onOpenExternally}
        />
      )
    }
    return (
      <div className="file-rendered">
        <MediaPreview
          kind={presentation}
          src={file.streamUrl}
          mime={file.mime}
          size={file.size}
          onOpenExternally={onOpenExternally}
        />
      </div>
    )
  }

  if (presentation === "pdf") {
    return (
      <Refusal
        headline={file.unavailable ?? "PDFs open outside Chat Hub."}
        file={file}
        onOpenExternally={onOpenExternally}
      />
    )
  }

  return (
    <Refusal
      headline="Binary file — showing it as text would only produce mojibake."
      file={file}
      onOpenExternally={onOpenExternally}
    />
  )
}

function SplitPane({
  editor,
  preview,
}: {
  editor: ReactNode
  preview: ReactNode
}) {
  return (
    <div className="file-split">
      <div className="file-split-edit">{editor}</div>
      <div className="file-split-preview">{preview}</div>
    </div>
  )
}

function Refusal({
  headline,
  file,
  onOpenExternally,
}: {
  headline: string
  file: OpenedFile
  onOpenExternally: () => void
}) {
  return (
    <div className="file-refusal">
      <p className="file-refusal-head">{headline}</p>
      <dl className="file-refusal-facts">
        <dt>Type</dt>
        <dd>{file.mime}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(file.size)}</dd>
      </dl>
      <button type="button" className="file-action" onClick={onOpenExternally}>
        Open with the system default
      </button>
    </div>
  )
}
