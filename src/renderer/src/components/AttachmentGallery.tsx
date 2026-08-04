import { useEffect, useRef, useState } from "react"
import type { MessageAttachment } from "@shared/types"
import { formatAttachmentSize } from "../lib/attachments"

type Props = {
  attachments: MessageAttachment[]
  removable?: boolean
  onRemove?: (path: string) => void
  onOpen: (attachment: MessageAttachment, trigger: HTMLButtonElement) => void
  className?: string
}

function AttachmentCard({
  attachment,
  removable,
  onRemove,
  onOpen,
}: {
  attachment: MessageAttachment
  removable: boolean
  onRemove?: (path: string) => void
  onOpen: Props["onOpen"]
}) {
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const previewRef = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(attachment.kind !== "image")
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    attachment.kind === "image" ? "idle" : "ready",
  )

  useEffect(() => {
    if (attachment.kind !== "image" || visible) return
    const target = previewRef.current
    if (!target || !("IntersectionObserver" in window)) {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      setVisible(true)
      observer.disconnect()
    }, { rootMargin: "160px" })
    observer.observe(target)
    return () => observer.disconnect()
  }, [attachment.kind, visible])

  useEffect(() => {
    if (attachment.kind !== "image" || !visible) return
    let alive = true
    setStatus("loading")
    setThumbnail(null)
    void window.chatHub.readImageDataUrl(attachment.path, 320).then((url) => {
      if (!alive) return
      setThumbnail(url)
      setStatus(url ? "ready" : "error")
    }).catch(() => {
      if (alive) setStatus("error")
    })
    return () => {
      alive = false
    }
  }, [attachment.kind, attachment.path, visible])

  return (
    <article className={`attachment-card is-${status}`} title={attachment.path}>
      {attachment.kind === "image" ? (
        <button
          ref={previewRef}
          type="button"
          className="attachment-preview"
          aria-label={`Open ${attachment.name}`}
          disabled={status !== "ready"}
          onClick={(event) => onOpen(attachment, event.currentTarget)}
        >
          {thumbnail ? <img src={thumbnail} alt="" /> : null}
          {status === "idle" || status === "loading" ? <span className="attachment-state">Loading…</span> : null}
          {status === "error" ? <span className="attachment-state">Unavailable</span> : null}
        </button>
      ) : (
        <div className="attachment-preview attachment-file" aria-hidden="true">FILE</div>
      )}
      <div className="attachment-caption">
        <span className="attachment-name">{attachment.name}</span>
        <span className="attachment-size">{formatAttachmentSize(attachment.sizeBytes)}</span>
      </div>
      {removable ? (
        <button
          type="button"
          className="attachment-remove"
          aria-label={`Remove ${attachment.name}`}
          title="Remove attachment"
          onClick={() => onRemove?.(attachment.path)}
        >
          ×
        </button>
      ) : null}
    </article>
  )
}

export function AttachmentGallery({ attachments, removable = false, onRemove, onOpen, className = "" }: Props) {
  if (attachments.length === 0) return null
  return (
    <div className={`attachment-grid ${className}`.trim()} aria-label="Attachments">
      {attachments.map((attachment) => (
        <AttachmentCard
          key={attachment.path}
          attachment={attachment}
          removable={removable}
          onRemove={onRemove}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}
