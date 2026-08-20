/**
 * A tool row that truncates a path on the right prints the same shared prefix
 * twenty times over. Paths therefore lose their head, never their tail:
 * `…/main/adapters/grok.ts` identifies a file, `/Users/…/chat-hub/src/…` does
 * not. Callers keep the untouched path for the title attribute.
 */

const PATH_MAX = 44
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** True for a bare filesystem path — never for a URL, a pattern or a sentence. */
export function looksLikePath(text: string): boolean {
  const value = text.trim()
  if (!value || /\s/.test(value)) return false
  if (SCHEME.test(value)) return false
  return value.includes("/")
}

/** The directory head, which may shrink, and the last segment, which may not. */
export function splitPath(path: string): { head: string; tail: string } {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/")
  if (cut < 0) return { head: "", tail: path }
  return { head: path.slice(0, cut + 1), tail: path.slice(cut + 1) }
}

/**
 * Keep whole trailing segments until the budget runs out, then say what was
 * dropped. A last segment that is itself too long is cut from its own left.
 */
export function shortenPath(path: string, max = PATH_MAX): string {
  const clean = path.trim()
  if (clean.length <= max) return clean
  const parts = clean.split("/")
  let kept = parts[parts.length - 1] ?? ""
  if (kept.length + 2 > max) {
    return `…${kept.slice(kept.length - Math.max(1, max - 1))}`
  }
  for (let at = parts.length - 2; at >= 0; at -= 1) {
    const wider = `${parts[at]}/${kept}`
    if (wider.length + 2 > max) break
    kept = wider
  }
  return kept === clean ? clean : `…/${kept}`
}

/** `shortenPath` for text that may or may not be a path; anything else passes. */
export function shortenIfPath(text: string, max = PATH_MAX): string {
  return looksLikePath(text) ? shortenPath(text, max) : text
}
