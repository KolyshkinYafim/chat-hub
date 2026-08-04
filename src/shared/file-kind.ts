export type MediaKind = "text" | "image" | "video" | "audio" | "pdf" | "binary"

export type FileType = { kind: MediaKind; mime: string }

export const MAGIC_SNIFF_BYTES = 64

export const TEXT_TYPE: FileType = { kind: "text", mime: "text/plain" }

export const BINARY_TYPE: FileType = {
  kind: "binary",
  mime: "application/octet-stream",
}

const image = (mime: string): FileType => ({ kind: "image", mime })
const video = (mime: string): FileType => ({ kind: "video", mime })
const audio = (mime: string): FileType => ({ kind: "audio", mime })

const PDF_TYPE: FileType = { kind: "pdf", mime: "application/pdf" }

const EXTENSION_TYPES: Record<string, FileType> = {
  png: image("image/png"),
  jpg: image("image/jpeg"),
  jpeg: image("image/jpeg"),
  gif: image("image/gif"),
  webp: image("image/webp"),
  svg: image("image/svg+xml"),
  avif: image("image/avif"),
  bmp: image("image/bmp"),
  ico: image("image/x-icon"),
  heic: image("image/heic"),
  tif: image("image/tiff"),
  tiff: image("image/tiff"),

  mp4: video("video/mp4"),
  m4v: video("video/mp4"),
  mov: video("video/quicktime"),
  webm: video("video/webm"),
  mkv: video("video/x-matroska"),
  avi: video("video/x-msvideo"),

  mp3: audio("audio/mpeg"),
  wav: audio("audio/wav"),
  m4a: audio("audio/mp4"),
  aac: audio("audio/aac"),
  ogg: audio("audio/ogg"),
  oga: audio("audio/ogg"),
  opus: audio("audio/ogg"),
  flac: audio("audio/flac"),

  pdf: PDF_TYPE,

  zip: BINARY_TYPE,
  gz: BINARY_TYPE,
  tgz: BINARY_TYPE,
  bz2: BINARY_TYPE,
  xz: BINARY_TYPE,
  "7z": BINARY_TYPE,
  rar: BINARY_TYPE,
  tar: BINARY_TYPE,
  dmg: BINARY_TYPE,
  pkg: BINARY_TYPE,
  exe: BINARY_TYPE,
  dll: BINARY_TYPE,
  dylib: BINARY_TYPE,
  so: BINARY_TYPE,
  node: BINARY_TYPE,
  wasm: BINARY_TYPE,
  jar: BINARY_TYPE,
  class: BINARY_TYPE,
  pyc: BINARY_TYPE,
  bin: BINARY_TYPE,
  db: BINARY_TYPE,
  sqlite: BINARY_TYPE,
  sqlite3: BINARY_TYPE,
  woff: BINARY_TYPE,
  woff2: BINARY_TYPE,
  ttf: BINARY_TYPE,
  otf: BINARY_TYPE,
  icns: BINARY_TYPE,
  psd: BINARY_TYPE,
}

export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase()
}

export function fileTypeByExtension(path: string): FileType | null {
  return EXTENSION_TYPES[extensionOf(path)] ?? null
}

function ascii(head: Uint8Array, offset: number, marker: string): boolean {
  if (offset + marker.length > head.length) return false
  for (let i = 0; i < marker.length; i += 1) {
    if (head[offset + i] !== marker.charCodeAt(i)) return false
  }
  return true
}

function bytesAt(head: Uint8Array, offset: number, values: number[]): boolean {
  if (offset + values.length > head.length) return false
  for (let i = 0; i < values.length; i += 1) {
    if (head[offset + i] !== values[i]) return false
  }
  return true
}

function brandAt(head: Uint8Array, offset: number): string {
  let out = ""
  for (let i = offset; i < offset + 4 && i < head.length; i += 1) {
    out += String.fromCharCode(head[i]!)
  }
  return out
}

export function fileTypeByContent(head: Uint8Array): FileType | null {
  if (ascii(head, 0, "\x89PNG\r\n\x1a\n")) return image("image/png")
  if (bytesAt(head, 0, [0xff, 0xd8, 0xff])) return image("image/jpeg")
  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) {
    return image("image/gif")
  }
  if (ascii(head, 0, "RIFF")) {
    if (ascii(head, 8, "WEBP")) return image("image/webp")
    if (ascii(head, 8, "WAVE")) return audio("audio/wav")
    if (ascii(head, 8, "AVI ")) return video("video/x-msvideo")
  }
  if (ascii(head, 4, "ftyp")) {
    const brand = brandAt(head, 8)
    if (brand.startsWith("qt")) return video("video/quicktime")
    if (brand.startsWith("M4A")) return audio("audio/mp4")
    if (brand === "avif" || brand === "avis") return image("image/avif")
    if (brand === "heic" || brand === "heix" || brand === "mif1") {
      return image("image/heic")
    }
    return video("video/mp4")
  }
  if (bytesAt(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) return video("video/webm")
  if (ascii(head, 0, "%PDF-")) return PDF_TYPE
  if (ascii(head, 0, "ID3")) return audio("audio/mpeg")
  if (head.length > 1 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) {
    return audio("audio/mpeg")
  }
  if (ascii(head, 0, "OggS")) return audio("audio/ogg")
  if (ascii(head, 0, "fLaC")) return audio("audio/flac")
  if (ascii(head, 0, "PK\x03\x04")) return BINARY_TYPE
  if (bytesAt(head, 0, [0x1f, 0x8b])) return BINARY_TYPE
  if (ascii(head, 0, "\x7fELF")) return BINARY_TYPE
  if (ascii(head, 0, "\0asm")) return BINARY_TYPE
  if (
    bytesAt(head, 0, [0xcf, 0xfa, 0xed, 0xfe]) ||
    bytesAt(head, 0, [0xce, 0xfa, 0xed, 0xfe]) ||
    bytesAt(head, 0, [0xca, 0xfe, 0xba, 0xbe])
  ) {
    return BINARY_TYPE
  }
  return null
}

export function detectFileType(path: string, head: Uint8Array): FileType {
  const sniffed = fileTypeByContent(head)
  if (sniffed) return sniffed
  const byExtension = fileTypeByExtension(path)
  if (byExtension) return byExtension
  return head.includes(0) ? BINARY_TYPE : TEXT_TYPE
}

export function carriesEditableText(type: FileType): boolean {
  return type.kind === "text" || type.mime === "image/svg+xml"
}
