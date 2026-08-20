/**
 * Per-project context: plain markdown under `<cwd>/.chathub/context/`, next to
 * the board and the project scripts. The owner edits the files in any editor and
 * commits them; the agent can read and rewrite them like any other file in the
 * workspace. Nothing here is app-private state — the only non-markdown piece is
 * `.chathub/context.json`, which records whether the brief is sent to the agent.
 */

export type ContextDocId = "overview" | "stack" | "conventions" | "focus"

export type ContextDocSpec = {
  id: ContextDocId
  file: string
  /** Heading used in the brief the agent receives. */
  title: string
  /** Short form for the surface's tab strip, which is only ~300px wide. */
  label: string
  hint: string
}

export const CONTEXT_DIR_REL = ".chathub/context"

export const CONTEXT_SETTINGS_REL = ".chathub/context.json"

/**
 * Four documents, split by how often each one changes rather than by topic: the
 * identity that almost never moves, the toolchain that a machine can re-detect
 * and overwrite, the rules that are argued over rarely, and the "right now" that
 * goes stale in days. A single file would make the re-detect overwrite unsafe
 * and would blur what the owner is expected to keep current.
 */
export const CONTEXT_DOCS: readonly ContextDocSpec[] = [
  {
    id: "overview",
    file: "overview.md",
    title: "Overview",
    label: "Overview",
    hint: "What this project is, who it is for, where to start reading.",
  },
  {
    id: "stack",
    file: "stack.md",
    title: "Stack",
    label: "Stack",
    hint: "Languages, tooling and the commands that run it. Detected from the repo.",
  },
  {
    id: "conventions",
    file: "conventions.md",
    title: "Conventions",
    label: "Conventions",
    hint: "How work is done here — the house rules an agent should follow.",
  },
  {
    id: "focus",
    file: "focus.md",
    title: "Current focus",
    label: "Focus",
    hint: "What is being worked on right now. Pairs with the board's todos.",
  },
]

export type ContextDoc = {
  id: ContextDocId
  file: string
  title: string
  text: string
  /** mtime of the file on disk; 0 for a draft that was never written. */
  updatedAt: number
}

export type ProjectContext = {
  docs: ContextDoc[]
  /**
   * False when `.chathub/context/` holds none of the four documents yet — the
   * `docs` are then a detected draft held in memory, never written and never
   * sent to the agent until the owner creates the folder.
   */
  seeded: boolean
  /** Whether the brief is appended to the agent's system prompt every turn. */
  share: boolean
  /** Newest doc mtime; the surface polls on it to adopt the agent's own edits. */
  updatedAt: number
}

/** What we record when the owner creates the folder here: they wrote it to be used. */
export const DEFAULT_CONTEXT_SHARE = true

/**
 * What an unrecorded folder means. A `.chathub/context/` that arrived with
 * someone else's checkout has never been anyone's decision on this machine, and
 * sharing it would quietly add its tokens to every turn — so it stays silent
 * until the switch is thrown. Creating the folder here records `true` instead.
 */
export const SHARE_WHEN_UNRECORDED = false

/** Ceiling on one document, so a stray paste cannot become the system prompt. */
export const CONTEXT_DOC_LIMIT_CHARS = 32_000

/** Budget for the whole brief, before the truncation notice is appended. */
export const CONTEXT_BRIEF_LIMIT_CHARS = 4000

/** Open todos carried into the brief alongside the focus document. */
export const CONTEXT_BRIEF_TODOS = 8

const BRIEF_HEADER =
  "Project context — maintained by the owner in `.chathub/context/` in this workspace. " +
  "It is background for the whole session, not an instruction for this turn. " +
  "If the repository contradicts it, trust the repository and say so."

export function contextDocSpec(id: unknown): ContextDocSpec | null {
  return CONTEXT_DOCS.find((doc) => doc.id === id) ?? null
}

/** Rough token count for the cost line in the UI: ~4 characters per token. */
export function estimateContextTokens(text: string): number {
  return text.trim() === "" ? 0 : Math.ceil(text.trim().length / 4)
}

/**
 * Drop a leading `# Title` line: the file keeps its heading for a human reading
 * it in an editor, while the brief supplies its own `## Title` so the agent does
 * not receive the same words twice.
 */
function stripLeadingHeading(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith("# ")) return trimmed
  const nl = trimmed.indexOf("\n")
  return nl === -1 ? "" : trimmed.slice(nl + 1).trim()
}

function todoBlock(openTodos: readonly string[]): string {
  const shown = openTodos
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .slice(0, CONTEXT_BRIEF_TODOS)
  if (shown.length === 0) return ""
  const lines = shown.map((text) => `- [ ] ${text}`)
  const more = openTodos.length - shown.length
  if (more > 0) lines.push(`- …and ${more} more`)
  return `Open todos (\`.chathub/board.json\`):\n${lines.join("\n")}`
}

/**
 * Clamp to the budget on a line boundary. The notice lands after the budget on
 * purpose: the point of the cap is bounding the context, and a caller that gets
 * a silently shortened brief has no way to know it was cut.
 */
function clampBrief(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const nl = cut.lastIndexOf("\n")
  const kept = (nl > limit / 2 ? cut.slice(0, nl) : cut).trimEnd()
  return `${kept}\n\n(Context truncated at ${limit} characters — shorten .chathub/context to send all of it.)`
}

/**
 * The exact text appended to the agent's system prompt. Empty documents are
 * skipped, so a project that only filled in the focus sends one short section.
 * The board's open todos ride along under the focus heading: "what we are doing
 * right now" is one thought, and splitting it across two panels helps nobody.
 * They only ride along, though — a folder of empty documents sends nothing, so
 * turning context on can never quietly become "paste the board every turn".
 */
export function buildContextBrief(
  docs: readonly ContextDoc[],
  openTodos: readonly string[] = [],
  limit: number = CONTEXT_BRIEF_LIMIT_CHARS,
): string {
  const bodies = new Map<ContextDocId, string>()
  for (const spec of CONTEXT_DOCS) {
    const body = stripLeadingHeading(docs.find((d) => d.id === spec.id)?.text ?? "")
    if (body !== "") bodies.set(spec.id, body)
  }
  if (bodies.size === 0) return ""
  const todos = todoBlock(openTodos)
  if (todos !== "") {
    const focus = bodies.get("focus")
    bodies.set("focus", focus ? `${focus}\n\n${todos}` : todos)
  }
  const sections = CONTEXT_DOCS.filter((spec) => bodies.has(spec.id)).map(
    (spec) => `## ${spec.title}\n${bodies.get(spec.id) ?? ""}`,
  )
  return clampBrief(`${BRIEF_HEADER}\n\n${sections.join("\n\n")}`, limit)
}

/** One line for the board's header strip: the first sentence of real prose. */
export function contextHeadline(text: string, max = 120): string {
  const lines = text.split("\n").map((line) => line.trim())
  const prose = lines.find(
    (line) => line !== "" && !line.startsWith("#") && !line.startsWith("- "),
  )
  const heading = lines.find((line) => line.startsWith("#"))
  const pick = prose ?? heading?.replace(/^#+\s*/, "") ?? ""
  const flat = pick.replace(/[*_`]/g, "").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export type ContextSettings = { share: boolean; updatedAt: number }

/** Hand-editable file: anything unparseable falls back to sharing. */
export function parseContextSettings(raw: unknown): ContextSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { share: SHARE_WHEN_UNRECORDED, updatedAt: 0 }
  }
  const o = raw as Record<string, unknown>
  const updatedAt =
    typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) && o.updatedAt > 0
      ? o.updatedAt
      : 0
  return {
    share: typeof o.share === "boolean" ? o.share : SHARE_WHEN_UNRECORDED,
    updatedAt,
  }
}
