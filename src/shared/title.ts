const MAX_TITLE_CHARS = 48
const MAX_TITLE_WORDS = 8

const PROVIDER_IDS = "mock|grok|claude|codex|opencode"
const DEFAULT_SHAPES = [
  new RegExp(`^.+ · (?:${PROVIDER_IDS}) · \\d{1,2}:\\d{2}$`),
  /^new · .+$/i,
]

/** Derive an instant title from the first user message; null when it yields nothing readable. */
export function heuristicTitle(firstMessage: string): string | null {
  let text = firstMessage
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```[\s\S]*$/, " ")
    .replace(/(^|\s)@\S+/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()

  const sentence = /^(.*?[.!?])(?=\s)/.exec(text)
  if (sentence) text = sentence[1]
  text = text.replace(/[\s.!?…]+$/, "")

  const words = text.split(" ")
  if (words.length > MAX_TITLE_WORDS) {
    text = words.slice(0, MAX_TITLE_WORDS).join(" ")
  }
  if (text.length > MAX_TITLE_CHARS) {
    const cut = text.slice(0, MAX_TITLE_CHARS - 1)
    const space = cut.lastIndexOf(" ")
    text = (space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, "") + "…"
  }

  if (text.length < 3) return null
  if (!/[\p{L}\p{N}]/u.test(text)) return null
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** True for machine-generated titles (defaultTitle() in session-manager); those may be replaced. */
export function looksDefaultTitle(title: string): boolean {
  const t = title.trim()
  if (!t) return true
  return DEFAULT_SHAPES.some((shape) => shape.test(t))
}

/** Clean a raw LLM answer into a usable title; null when the model rambled instead. */
export function sanitizeLlmTitle(raw: string): string | null {
  let t =
    raw
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  t = t.replace(/^(?:title|название|заголовок)\s*[:：]\s*/i, "")
  t = t.replace(/^["'«“‘]+/, "").replace(/["'»”’]+$/, "")
  t = t.replace(/[\s.!?;:,]+$/, "").replace(/\s+/g, " ").trim()
  if (!t) return null
  if (t.length > 64) return null
  if (!/[\p{L}\p{N}]/u.test(t)) return null
  if (/^(?:here (?:is|are)|here's|sure|of course|okay|вот|конечно)\b/i.test(t)) {
    return null
  }
  return t
}
