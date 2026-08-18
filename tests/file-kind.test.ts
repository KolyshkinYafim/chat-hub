import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  MAGIC_SNIFF_BYTES,
  detectFileType,
  extensionOf,
  fileTypeByContent,
  fileTypeByExtension,
} from "../src/shared/file-kind"

const FIXTURES = join(__dirname, "..", "fixtures", "files-surface")

async function head(name: string): Promise<Uint8Array> {
  const bytes = await readFile(join(FIXTURES, name))
  return new Uint8Array(bytes.subarray(0, MAGIC_SNIFF_BYTES))
}

const utf8 = (text: string) => new TextEncoder().encode(text)

describe("extension parsing", () => {
  it("takes the last segment and lowercases the suffix", () => {
    expect(extensionOf("src/App.TSX")).toBe("tsx")
    expect(extensionOf("a.b/c.tar.gz")).toBe("gz")
  })

  it("treats a dotfile as having no extension", () => {
    expect(extensionOf(".env")).toBe("")
    expect(extensionOf("src/.gitignore")).toBe("")
    expect(extensionOf("Makefile")).toBe("")
  })
})

describe("detection by extension", () => {
  it("maps every family the viewer switches on", () => {
    expect(fileTypeByExtension("a.png")).toEqual({
      kind: "image",
      mime: "image/png",
    })
    expect(fileTypeByExtension("a.svg")).toEqual({
      kind: "image",
      mime: "image/svg+xml",
    })
    expect(fileTypeByExtension("a.mov")).toEqual({
      kind: "video",
      mime: "video/quicktime",
    })
    expect(fileTypeByExtension("a.mp3")).toEqual({
      kind: "audio",
      mime: "audio/mpeg",
    })
    expect(fileTypeByExtension("a.pdf")?.kind).toBe("pdf")
    expect(fileTypeByExtension("a.woff2")?.kind).toBe("binary")
  })

  it("has no opinion about source files", () => {
    expect(fileTypeByExtension("a.ts")).toBeNull()
    expect(fileTypeByExtension("a.md")).toBeNull()
    expect(fileTypeByExtension("a.mmd")).toBeNull()
  })
})

describe("detection by content sniff", () => {
  it("reads the real fixture bytes", async () => {
    expect(fileTypeByContent(await head("logo.png"))).toEqual({
      kind: "image",
      mime: "image/png",
    })
    expect(fileTypeByContent(await head("clip.mp4"))).toEqual({
      kind: "video",
      mime: "video/mp4",
    })
    expect(fileTypeByContent(await head("tone.m4a"))).toEqual({
      kind: "audio",
      mime: "audio/mp4",
    })
  })

  it("knows the headers no fixture covers", () => {
    expect(fileTypeByContent(utf8("GIF89a…"))?.mime).toBe("image/gif")
    expect(fileTypeByContent(utf8("%PDF-1.7"))?.kind).toBe("pdf")
    expect(fileTypeByContent(utf8("OggS"))?.mime).toBe("audio/ogg")
    expect(fileTypeByContent(utf8("ID3\x03"))?.mime).toBe("audio/mpeg")
    expect(
      fileTypeByContent(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.mime,
    ).toBe("image/jpeg")
    expect(
      fileTypeByContent(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))?.mime,
    ).toBe("video/webm")
    expect(fileTypeByContent(utf8("PK\x03\x04"))?.kind).toBe("binary")
  })

  it("tells a RIFF container apart by its form type", () => {
    const riff = (form: string) => utf8(`RIFF????${form}`)
    expect(fileTypeByContent(riff("WEBP"))?.mime).toBe("image/webp")
    expect(fileTypeByContent(riff("WAVE"))?.mime).toBe("audio/wav")
  })

  it("stays silent on plain text", () => {
    expect(fileTypeByContent(utf8("export const app = 1\n"))).toBeNull()
    expect(fileTypeByContent(new Uint8Array())).toBeNull()
  })
})

describe("combined detection", () => {
  it("lets magic bytes beat a lying extension", async () => {
    expect(detectFileType("notes.txt", await head("logo.png"))).toEqual({
      kind: "image",
      mime: "image/png",
    })
  })

  it("falls back to the extension when nothing is recognisable", () => {
    expect(detectFileType("a.svg", utf8("<svg xmlns="))?.mime).toBe(
      "image/svg+xml",
    )
  })

  it("calls unknown bytes with a NUL binary and the rest text", async () => {
    expect(detectFileType("payload.bin", await head("payload.bin")).kind).toBe(
      "binary",
    )
    expect(
      detectFileType("mystery", new Uint8Array([0x61, 0x00, 0x62])).kind,
    ).toBe("binary")
    expect(detectFileType("mystery", utf8("plain words")).kind).toBe("text")
    expect(detectFileType("app.ts", utf8("const a = 1")).mime).toBe("text/plain")
  })
})
