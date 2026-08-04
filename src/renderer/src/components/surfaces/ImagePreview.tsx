import { useState } from "react"
import { formatBytes } from "../../lib/format"

type Props = {
  src: string
  mime: string
  size: number
  name: string
}

export function ImagePreview({ src, mime, size, name }: Props) {
  const [dimensions, setDimensions] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <p className="surface-note error">
        {mime} could not be decoded for display.
      </p>
    )
  }

  return (
    <div className="file-image">
      <div className="file-image-stage">
        <img
          src={src}
          alt={name}
          onLoad={(e) =>
            setDimensions(
              `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`,
            )
          }
          onError={() => setFailed(true)}
        />
      </div>
      <div className="file-image-facts">
        <span>{mime}</span>
        {dimensions ? <span>{dimensions} px</span> : null}
        <span>{formatBytes(size)}</span>
      </div>
    </div>
  )
}
