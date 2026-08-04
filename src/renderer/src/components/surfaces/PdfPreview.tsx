import { useMemo } from "react"

/**
 * PDFs get a guest of their own rather than a frame in the Hub's own document:
 * the file is served by the opaque `chathub-media://` grant, and main pins that
 * guest to node-free, sandboxed, plugin-less preferences that can never reach
 * the web (see `hardenWebviewHost`).
 */
type Props = {
  src: string
  onOpenExternally: () => void
}

function supportsWebviewTag(): boolean {
  if (typeof document === "undefined") return false
  const probe = document.createElement("webview") as Partial<{
    reload: () => void
  }>
  return typeof probe.reload === "function"
}

export function PdfPreview({ src, onOpenExternally }: Props) {
  const embedded = useMemo(supportsWebviewTag, [])

  if (!embedded) {
    return (
      <div className="file-refusal">
        <p className="file-refusal-head">
          Inline PDFs need the desktop app — this is the browser dev server.
        </p>
        <button type="button" className="file-action" onClick={onOpenExternally}>
          Open with the system default
        </button>
      </div>
    )
  }

  return (
    <div className="file-pdf">
      <webview src={src} className="file-pdf-view" />
    </div>
  )
}
