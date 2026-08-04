import { useState } from "react"
import { formatBytes } from "../../lib/format"

type Props = {
  kind: "video" | "audio"
  src: string
  mime: string
  size: number
  onOpenExternally: () => void
}

export function MediaPreview({
  kind,
  src,
  mime,
  size,
  onOpenExternally,
}: Props) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div className="file-refusal">
        <p className="surface-note error">
          This build could not play {mime} inline.
        </p>
        <button type="button" className="file-action" onClick={onOpenExternally}>
          Open in the system player
        </button>
      </div>
    )
  }

  return (
    <div className={`file-media file-media-${kind}`}>
      {kind === "video" ? (
        <video src={src} controls preload="metadata" onError={() => setFailed(true)} />
      ) : (
        <audio src={src} controls preload="metadata" onError={() => setFailed(true)} />
      )}
      <div className="file-image-facts">
        <span>{mime}</span>
        <span>{formatBytes(size)}</span>
      </div>
    </div>
  )
}
