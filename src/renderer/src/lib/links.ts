const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"»]+$/

export const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?»]/g

export type LinkDisplay = {
  host: string
  label: string
  hint: string | null
}

export function trimTrailingPunctuation(raw: string): string {
  return raw.replace(TRAILING_PUNCTUATION, "")
}

export function isBareUrlParagraph(text: string): string | null {
  const trimmed = text.trim()
  if (!/^https?:\/\/\S+$/.test(trimmed)) return null
  const cleaned = trimTrailingPunctuation(trimmed)
  return isSafeHttpUrl(cleaned) ? cleaned : null
}

export function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === "https:" || parsed.protocol === "http:"
  } catch {
    return false
  }
}

const REF_PATTERNS: [RegExp, (n: string) => string][] = [
  [/\/(?:-\/)?merge_requests\/(\d+)/, (n) => `MR !${n}`],
  [/\/pull\/(\d+)/, (n) => `PR #${n}`],
  [/\/issues\/(\d+)/, (n) => `Issue #${n}`],
]

export function linkDisplay(raw: string): LinkDisplay {
  const url = trimTrailingPunctuation(raw)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { host: "", label: middleTruncate(url, 48), hint: null }
  }
  const host = parsed.host.replace(/^www\./, "")
  let hint: string | null = null
  for (const [pattern, render] of REF_PATTERNS) {
    const m = pattern.exec(parsed.pathname)
    if (m) {
      hint = render(m[1])
      break
    }
  }
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
  const label = rest === "/" || rest === "" ? host : middleTruncate(rest, 44)
  return { host, label, hint }
}

export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) * 0.6)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}
