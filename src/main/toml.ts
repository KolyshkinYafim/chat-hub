/**
 * A TOML key: bare when it qualifies, otherwise a basic string.
 * JSON string escaping is a subset of TOML basic-string escaping,
 * so JSON.stringify produces a valid quoted TOML key.
 */
export function tomlKey(k: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return k
  return JSON.stringify(k)
}
