import { useEffect, useMemo, useRef, useState } from "react"
import type { MessageAttachment } from "@shared/types"
import { clampZoom, imageAttachments, wrappedIndex } from "../lib/attachments"

type Props = {
  attachments: MessageAttachment[]
  initialPath: string
  returnFocus: HTMLElement | null
  onClose: () => void
}

export function AttachmentLightbox({ attachments, initialPath, returnFocus, onClose }: Props) {
  const images = useMemo(() => imageAttachments(attachments), [attachments])
  const initialIndex = Math.max(0, images.findIndex((item) => item.path === initialPath))
  const [index, setIndex] = useState(initialIndex)
  const [zoom, setZoom] = useState(1)
  const [url, setUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const current = images[index]

  useEffect(() => {
    closeRef.current?.focus()
    return () => returnFocus?.focus()
  }, [returnFocus])

  useEffect(() => {
    if (!current) return
    let alive = true
    setZoom(1)
    setUrl(null)
    setStatus("loading")
    void window.chatHub.readImageDataUrl(current.path).then((next) => {
      if (!alive) return
      setUrl(next)
      setStatus(next ? "ready" : "error")
    }).catch(() => {
      if (alive) setStatus("error")
    })
    return () => {
      alive = false
    }
  }, [current])

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Tab") {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])
        if (controls.length === 0) return
        const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement)
        const nextIndex = event.shiftKey
          ? (currentIndex <= 0 ? controls.length - 1 : currentIndex - 1)
          : (currentIndex + 1) % controls.length
        controls[nextIndex]?.focus()
      } else if (event.key === "Escape") onClose()
      else if (event.key === "ArrowLeft" && images.length > 1) {
        setIndex((value) => wrappedIndex(value, -1, images.length))
      } else if (event.key === "ArrowRight" && images.length > 1) {
        setIndex((value) => wrappedIndex(value, 1, images.length))
      } else if (event.key === "+" || event.key === "=") {
        setZoom((value) => clampZoom(value + 0.25))
      } else if (event.key === "-") {
        setZoom((value) => clampZoom(value - 0.25))
      } else return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [images.length, onClose])

  if (!current) return null
  const hasNavigation = images.length > 1
  return (
    <div
      className="attachment-lightbox"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${current.name}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="lightbox-topbar">
        <span className="lightbox-title">{current.name}</span>
        <span className="lightbox-count">{index + 1} / {images.length}</span>
        <div className="lightbox-tools">
          <button type="button" className="icon-chip lg" aria-label="Zoom out" onClick={() => setZoom((value) => clampZoom(value - 0.25))}>−</button>
          <button type="button" className="lightbox-zoom" aria-label="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" className="icon-chip lg" aria-label="Zoom in" onClick={() => setZoom((value) => clampZoom(value + 0.25))}>+</button>
          <button ref={closeRef} type="button" className="icon-chip lg" aria-label="Close preview" onClick={onClose}>×</button>
        </div>
      </div>
      {hasNavigation ? (
        <button type="button" className="icon-chip lightbox-nav previous" aria-label="Previous image" onClick={() => setIndex((value) => wrappedIndex(value, -1, images.length))}>‹</button>
      ) : null}
      <div
        className="lightbox-stage"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        {status === "loading" ? <span className="lightbox-state">Loading original…</span> : null}
        {status === "error" ? <span className="lightbox-state">Image is missing or unreadable.</span> : null}
        {url ? <img src={url} alt={current.name} style={{ transform: `scale(${zoom})` }} /> : null}
      </div>
      {hasNavigation ? (
        <button type="button" className="icon-chip lightbox-nav next" aria-label="Next image" onClick={() => setIndex((value) => wrappedIndex(value, 1, images.length))}>›</button>
      ) : null}
    </div>
  )
}
