/**
 * Ordered-subsequence scorer for the ⌘K session switcher.
 * Consecutive hits and word starts score higher so a terse query ("pfauth")
 * ranks the session the user meant above an incidental match whose letters
 * happen to be scattered across the whole label.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0
  let from = 0
  let prev = -2
  for (const ch of q) {
    // Spaces only separate terms in a query; they never have to match.
    if (ch === " ") continue
    const hit = t.indexOf(ch, from)
    if (hit === -1) return null
    score += 1
    if (hit === prev + 1) score += 4
    if (hit === 0 || /[\s\-_/·.]/.test(t[hit - 1] ?? "")) score += 3
    prev = hit
    from = hit + 1
  }
  // Tie-break towards matches that finish early in the label.
  return score - Math.floor(prev / 16)
}
