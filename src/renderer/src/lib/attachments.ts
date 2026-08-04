import type { MessageAttachment } from "@shared/types"

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  const digits = value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${unit}`
}

export function imageAttachments(items: readonly MessageAttachment[]): MessageAttachment[] {
  return items.filter((item) => item.kind === "image")
}

export function clampZoom(value: number): number {
  return Math.min(4, Math.max(0.5, value))
}

export function wrappedIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (index + delta + length) % length
}
