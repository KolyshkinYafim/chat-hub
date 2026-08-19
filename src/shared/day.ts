export const DAY_MS = 86_400_000

/**
 * Local calendar day of a timestamp, "YYYY-MM-DD". Shared because main writes
 * the usage ledger's day keys and the renderer groups by them: two copies that
 * disagree by one hour would split a day in half.
 */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}
