/**
 * Read an untrusted JSON field as text for matching.
 *
 * Adapters branch on fields a CLI sends us — `ev.type`, a tool name, a
 * subtype. Those are strings until the day one arrives as an object, and
 * `String(obj)` answers "[object Object]": a value that compares, switches
 * and concatenates like any other string, so a structural surprise silently
 * picks a branch instead of failing to pick one. Anything that is not a
 * primitive reads as "" here, which no `case` and no `endsWith` accepts.
 */
export function asText(value: unknown): string {
  if (typeof value === "string") return value
  // An allowlist, not a denylist: only the primitives that have one obvious
  // spelling convert. Everything else — object, array, function, symbol,
  // null, undefined — is the case this helper exists to refuse.
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value)
  }
  return ""
}

/**
 * Render a value for a human reading an error message. The opposite call from
 * `asText`: here an object IS the interesting part, so it is spelled out
 * rather than blanked.
 */
export function describeValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "symbol") return value.toString()
  // Primitives are settled before the JSON attempt: stringify throws on a
  // bigint, and a caught throw would report it as "[object BigInt]".
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value)
  }
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit - 1).trimEnd()}…`
}
