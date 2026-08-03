export type SyntaxClass =
  | "plain"
  | "keyword"
  | "type"
  | "string"
  | "number"
  | "comment"
  | "punct"

export type SyntaxSpan = { start: number; end: number; cls: SyntaxClass }

type Grammar = {
  keywords: Set<string>
  types: Set<string>
  lineComment: string[]
  quotes: string[]
}

const words = (source: string) => new Set(source.split(" "))

const JS_KEYWORDS =
  "const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends super this async await yield import export from default try catch finally throw void null undefined true false static get set public private protected readonly abstract implements interface type enum namespace declare as satisfies keyof infer is"
const JS_TYPES =
  "string number boolean object symbol bigint any unknown never Array Promise Record Map Set Partial Required Readonly ReturnType Date RegExp Error JSON Math console window document"

const PY_KEYWORDS =
  "def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False async await self match case"
const PY_TYPES = "int float str bool list dict set tuple bytes object type print len range enumerate zip open super isinstance"

const SWIFT_KEYWORDS =
  "func class struct enum protocol extension var let return if else guard for while repeat switch case default break continue import init deinit self super static private public internal fileprivate open final lazy weak unowned throws rethrows try catch defer where as is in nil true false async await actor some any mutating"
const SWIFT_TYPES =
  "String Int Double Float Bool Array Dictionary Set Optional Void Data Date URL Error Result View Text Never CGFloat"

const SHELL_KEYWORDS =
  "if then else elif fi for while do done case esac function return local export readonly declare in select until time coproc set unset source alias"
const SHELL_TYPES = "echo cd ls cat grep sed awk cp mv rm mkdir git npm pnpm yarn node python curl exit test printf read"

const GO_KEYWORDS =
  "package import func var const type struct interface map chan go defer if else for range return switch case default break continue select fallthrough goto nil true false"
const GO_TYPES = "string int int64 int32 float64 bool byte rune error any make new len cap append copy delete panic recover print println"

const RUST_KEYWORDS =
  "fn let mut const static struct enum trait impl for while loop if else match return use mod pub crate self super as where ref move box dyn async await unsafe type in break continue true false"
const RUST_TYPES = "String str i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 bool char Vec Option Result Box Rc Arc HashMap Some None Ok Err"

const CSS_KEYWORDS = "important media supports keyframes import font-face root from to"
const CSS_TYPES = "color background border display flex grid margin padding font width height position top right bottom left overflow content"

const GRAMMARS: Record<string, Grammar> = {
  js: {
    keywords: words(JS_KEYWORDS),
    types: words(JS_TYPES),
    lineComment: ["//"],
    quotes: ['"', "'", "`"],
  },
  py: {
    keywords: words(PY_KEYWORDS),
    types: words(PY_TYPES),
    lineComment: ["#"],
    quotes: ['"', "'"],
  },
  swift: {
    keywords: words(SWIFT_KEYWORDS),
    types: words(SWIFT_TYPES),
    lineComment: ["//"],
    quotes: ['"'],
  },
  sh: {
    keywords: words(SHELL_KEYWORDS),
    types: words(SHELL_TYPES),
    lineComment: ["#"],
    quotes: ['"', "'"],
  },
  go: {
    keywords: words(GO_KEYWORDS),
    types: words(GO_TYPES),
    lineComment: ["//"],
    quotes: ['"', "`"],
  },
  rust: {
    keywords: words(RUST_KEYWORDS),
    types: words(RUST_TYPES),
    lineComment: ["//"],
    quotes: ['"'],
  },
  json: {
    keywords: words("true false null"),
    types: new Set<string>(),
    lineComment: [],
    quotes: ['"'],
  },
  css: {
    keywords: words(CSS_KEYWORDS),
    types: words(CSS_TYPES),
    lineComment: ["//"],
    quotes: ['"', "'"],
  },
  text: {
    keywords: new Set<string>(),
    types: new Set<string>(),
    lineComment: [],
    quotes: [],
  },
}

const BY_EXTENSION: Record<string, string> = {
  ts: "js",
  tsx: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  mts: "js",
  cts: "js",
  java: "js",
  kt: "js",
  c: "js",
  h: "js",
  cc: "js",
  cpp: "js",
  hpp: "js",
  cs: "js",
  py: "py",
  pyi: "py",
  swift: "swift",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  go: "go",
  rs: "rust",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  less: "css",
}

export function languageOf(path: string): string {
  const name = path.split("/").pop() ?? path
  const dot = name.lastIndexOf(".")
  if (dot === -1) return "text"
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "text"
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y
const NUMBER = /(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/y
const PUNCT = /[{}()[\].,;:?!<>=+\-*/%&|^~@#]/y

export function highlight(text: string, language: string): SyntaxSpan[] {
  const grammar = GRAMMARS[language] ?? GRAMMARS.text!
  const spans: SyntaxSpan[] = []
  let i = 0

  while (i < text.length) {
    const rest = text.slice(i)
    const comment = grammar.lineComment.find((token) => rest.startsWith(token))
    if (comment) {
      spans.push({ start: i, end: text.length, cls: "comment" })
      break
    }
    if (rest.startsWith("/*")) {
      const close = text.indexOf("*/", i + 2)
      const end = close === -1 ? text.length : close + 2
      spans.push({ start: i, end, cls: "comment" })
      i = end
      continue
    }

    const char = text[i]!
    if (grammar.quotes.includes(char)) {
      const end = closingQuote(text, i, char)
      spans.push({ start: i, end, cls: "string" })
      i = end
      continue
    }

    NUMBER.lastIndex = i
    const digits = NUMBER.exec(text)
    if (digits && digits.index === i) {
      spans.push({ start: i, end: i + digits[0].length, cls: "number" })
      i += digits[0].length
      continue
    }

    IDENTIFIER.lastIndex = i
    const word = IDENTIFIER.exec(text)
    if (word && word.index === i) {
      const value = word[0]
      const cls: SyntaxClass = grammar.keywords.has(value)
        ? "keyword"
        : grammar.types.has(value) || /^[A-Z]/.test(value)
          ? "type"
          : "plain"
      if (cls !== "plain") spans.push({ start: i, end: i + value.length, cls })
      i += value.length
      continue
    }

    PUNCT.lastIndex = i
    const punct = PUNCT.exec(text)
    if (punct && punct.index === i) {
      spans.push({ start: i, end: i + 1, cls: "punct" })
      i += 1
      continue
    }

    i += 1
  }

  return spans
}

function closingQuote(text: string, from: number, quote: string): number {
  let i = from + 1
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2
      continue
    }
    if (text[i] === quote) return i + 1
    i += 1
  }
  return text.length
}

export type StyledPiece = { text: string; cls: SyntaxClass; changed: boolean }

export function styleLine(
  text: string,
  language: string,
  changed: [number, number][],
): StyledPiece[] {
  const boundaries = new Set<number>([0, text.length])
  const spans = highlight(text, language)
  for (const span of spans) {
    boundaries.add(span.start)
    boundaries.add(span.end)
  }
  for (const [start, end] of changed) {
    boundaries.add(start)
    boundaries.add(end)
  }
  const cuts = [...boundaries].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b)

  const pieces: StyledPiece[] = []
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const start = cuts[i]!
    const end = cuts[i + 1]!
    if (end <= start) continue
    const span = spans.find((s) => s.start <= start && s.end >= end)
    const isChanged = changed.some(([from, to]) => from <= start && to >= end)
    pieces.push({
      text: text.slice(start, end),
      cls: span?.cls ?? "plain",
      changed: isChanged,
    })
  }
  return pieces
}
