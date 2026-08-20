import { isSafeHttpUrl, trimTrailingPunctuation, URL_PATTERN } from "./links"

/** What a `code span` actually holds — a shortcut and a path deserve their own look. */
export type CodeRole = "code" | "kbd" | "path"

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; role: CodeRole }
  | { kind: "link"; url: string; children: InlineToken[] }
  | { kind: "autolink"; url: string }
  | { kind: "image"; url: string; alt: string }
  | { kind: "strong"; children: InlineToken[] }
  | { kind: "em"; children: InlineToken[] }
  | { kind: "strike"; children: InlineToken[] }
  | { kind: "footnote"; label: string }

const URL_AT = new RegExp(URL_PATTERN.source, "y")
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>]/
const WORD = /[A-Za-z0-9_]/

const MODIFIERS = new Set([
  "cmd",
  "command",
  "ctrl",
  "control",
  "alt",
  "opt",
  "option",
  "shift",
  "meta",
  "super",
  "win",
  "fn",
  "⌘",
  "⌥",
  "⌃",
  "⇧",
])

const NAMED_KEYS = new Set([
  "enter",
  "return",
  "esc",
  "escape",
  "tab",
  "space",
  "backspace",
  "delete",
  "del",
  "home",
  "end",
  "pageup",
  "pagedown",
  "pgup",
  "pgdn",
  "up",
  "down",
  "left",
  "right",
  "insert",
  "↑",
  "↓",
  "←",
  "→",
  "⏎",
  "⇥",
])

const MODIFIER_SYMBOL = /^[⌘⌥⌃⇧]+\s?[A-Za-z0-9]$/
const FUNCTION_KEY = /^f([1-9]|1[0-2])$/
const PATH_SEGMENT = /^[\w.@~%+-]+$/
const PATH_EXTENSION = /\.[A-Za-z0-9]{1,8}$/

function isKeyToken(token: string): boolean {
  const lower = token.toLowerCase()
  return (
    MODIFIERS.has(lower) ||
    NAMED_KEYS.has(lower) ||
    FUNCTION_KEY.test(lower) ||
    [...token].length === 1
  )
}

export function classifyInlineCode(text: string): CodeRole {
  const trimmed = text.trim()
  if (trimmed === "") return "code"
  if (isKeyChord(trimmed)) return "kbd"
  if (isFilePath(trimmed)) return "path"
  return "code"
}

function isKeyChord(text: string): boolean {
  if (MODIFIER_SYMBOL.test(text)) return true
  const parts = text.split("+")
  if (parts.length === 1) return NAMED_KEYS.has(text.toLowerCase())
  if (parts.some((part) => part === "")) return false
  if (!parts.every(isKeyToken)) return false
  return parts.some((part) => MODIFIERS.has(part.toLowerCase()))
}

/** A path the app could plausibly open — not a URL and not prose with a slash. */
export function isFilePath(text: string): boolean {
  if (/\s/.test(text) || text.includes("://")) return false
  const rooted = /^(?:\/|\.\.?\/|~\/)/.test(text)
  if (!rooted && !text.includes("/")) return false
  const segments = text.replace(/^\//, "").split("/")
  if (segments.some((segment) => segment !== "" && !PATH_SEGMENT.test(segment)))
    return false
  const last = segments[segments.length - 1] ?? ""
  return rooted || PATH_EXTENSION.test(last)
}

/**
 * Flat-ish inline markdown: emphasis, code, links, images and footnote refs.
 * Emphasis nests one level so `**a `b`**` keeps the code span.
 */
export function parseInline(text: string): InlineToken[] {
  const out: InlineToken[] = []
  let plain = ""
  let i = 0

  const flush = () => {
    if (plain !== "") {
      out.push({ kind: "text", text: plain })
      plain = ""
    }
  }

  while (i < text.length) {
    const char = text[i]!

    if (char === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      plain += text[i + 1]
      i += 2
      continue
    }

    if (char === "`") {
      const span = readCode(text, i)
      if (span) {
        flush()
        out.push({
          kind: "code",
          text: span.text,
          role: classifyInlineCode(span.text),
        })
        i = span.next
        continue
      }
    }

    if (char === "!" && text[i + 1] === "[") {
      const link = readLink(text, i + 1)
      if (link) {
        flush()
        out.push({ kind: "image", url: link.url, alt: link.label })
        i = link.next
        continue
      }
    }

    if (char === "[") {
      const note = /^\[\^([^\]\s]+)\]/.exec(text.slice(i))
      if (note) {
        flush()
        out.push({ kind: "footnote", label: note[1]! })
        i += note[0].length
        continue
      }
      const link = readLink(text, i)
      if (link) {
        flush()
        out.push({
          kind: "link",
          url: link.url,
          children: parseInline(link.label),
        })
        i = link.next
        continue
      }
    }

    if (char === "*" || char === "_") {
      const run = runLength(text, i, char)
      const width = run >= 3 ? 3 : run
      const emphasis = readEmphasis(text, i, char, width)
      if (emphasis) {
        flush()
        out.push(emphasis.token)
        i = emphasis.next
        continue
      }
    }

    if (char === "~" && text[i + 1] === "~") {
      const strike = readDelimited(text, i, "~~")
      if (strike) {
        flush()
        out.push({ kind: "strike", children: parseInline(strike.body) })
        i = strike.next
        continue
      }
    }

    if (char === "h") {
      URL_AT.lastIndex = i
      const url = URL_AT.exec(text)
      if (url && url.index === i) {
        const clean = trimTrailingPunctuation(url[0])
        if (isSafeHttpUrl(clean)) {
          flush()
          out.push({ kind: "autolink", url: clean })
          i += clean.length
          continue
        }
      }
    }

    plain += char
    i += 1
  }

  flush()
  return out
}

function runLength(text: string, from: number, char: string): number {
  let n = 0
  while (text[from + n] === char) n += 1
  return n
}

function readCode(text: string, from: number): { text: string; next: number } | null {
  const ticks = runLength(text, from, "`")
  const fence = "`".repeat(ticks)
  const close = text.indexOf(fence, from + ticks)
  if (close === -1) return null
  const body = text.slice(from + ticks, close)
  if (body.trim() === "") return null
  return { text: body.trim(), next: close + ticks }
}

function readLink(
  text: string,
  from: number,
): { label: string; url: string; next: number } | null {
  let depth = 0
  let close = -1
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1
      continue
    }
    if (text[i] === "[") depth += 1
    if (text[i] === "]") {
      depth -= 1
      if (depth === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1 || text[close + 1] !== "(") return null
  const end = text.indexOf(")", close + 2)
  if (end === -1) return null
  const target = text.slice(close + 2, end).trim()
  if (target === "" || /\s/.test(target)) return null
  return { label: text.slice(from + 1, close), url: target, next: end + 1 }
}

function readDelimited(
  text: string,
  from: number,
  fence: string,
): { body: string; next: number } | null {
  const start = from + fence.length
  const close = text.indexOf(fence, start)
  if (close === -1) return null
  const body = text.slice(start, close)
  if (body.trim() === "" || /^\s|\s$/.test(body)) return null
  return { body, next: close + fence.length }
}

function readEmphasis(
  text: string,
  from: number,
  char: string,
  width: number,
): { token: InlineToken; next: number } | null {
  // `snake_case` must not turn into emphasis, so an underscore only opens at
  // a word boundary. Asterisks have no such ambiguity.
  if (char === "_") {
    const before = text[from - 1]
    if (before !== undefined && WORD.test(before)) return null
  }
  const fence = char.repeat(width)
  const found = readDelimited(text, from, fence)
  if (!found) return null
  if (char === "_") {
    const after = text[found.next]
    if (after !== undefined && WORD.test(after)) return null
  }
  const children = parseInline(found.body)
  if (width === 3) {
    return {
      token: { kind: "strong", children: [{ kind: "em", children }] },
      next: found.next,
    }
  }
  const kind = width === 2 ? "strong" : "em"
  return { token: { kind, children }, next: found.next }
}

/** The text a human would read out of inline tokens — used by copy and titles. */
export function inlineToPlainText(tokens: InlineToken[]): string {
  return tokens
    .map((token) => {
      switch (token.kind) {
        case "text":
          return token.text
        case "code":
          return token.text
        case "autolink":
          return token.url
        case "image":
          return token.alt || token.url
        case "footnote":
          return `[^${token.label}]`
        case "link": {
          const label = inlineToPlainText(token.children)
          return label === token.url ? token.url : `${label} (${token.url})`
        }
        default:
          return inlineToPlainText(token.children)
      }
    })
    .join("")
}
