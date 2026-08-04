export type ByteRange = { start: number; end: number }

/**
 * Electron's own `file://` reader honours a Range header but always answers
 * 200 with no Content-Range, which reads to Chromium as "not seekable". The
 * media protocol parses the range itself so it can reply with the 206 a video
 * element needs — and returns null for anything it could not parse, so the
 * handler falls back to serving the whole file rather than claiming a range it
 * did not honour.
 */
export function parseByteRange(
  header: string | null,
  size: number,
): ByteRange | null {
  if (!header || size === 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const rawStart = match[1]!
  const rawEnd = match[2]!
  if (rawStart === "" && rawEnd === "") return null

  if (rawStart === "") {
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    return { start: Math.max(0, size - length), end: size - 1 }
  }

  const start = Number(rawStart)
  const end = rawEnd === "" ? size - 1 : Number(rawEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}
