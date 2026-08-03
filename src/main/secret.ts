import { safeStorage } from "electron"

/**
 * Encrypt provider secrets (API keys) at rest using the OS keychain via
 * Electron's safeStorage. Stored strings are tagged so we can tell an
 * encrypted blob from an accidental plaintext value on load.
 *
 * The renderer never receives these values — only their key names.
 */
const ENC_PREFIX = "enc:v1:"
const PLAIN_PREFIX = "plain:v1:"

function available(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Encrypt a secret for storage. Falls back to a tagged plaintext form. */
export function sealSecret(value: string): string {
  if (available()) {
    try {
      const buf = safeStorage.encryptString(value)
      return ENC_PREFIX + buf.toString("base64")
    } catch {
      // fall through to plaintext
    }
  }
  return PLAIN_PREFIX + Buffer.from(value, "utf8").toString("base64")
}

/** Decrypt a stored secret. Returns "" if it cannot be recovered. */
export function openSecret(stored: string): string {
  if (typeof stored !== "string") return ""
  if (stored.startsWith(ENC_PREFIX)) {
    if (!available()) return ""
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64")
      return safeStorage.decryptString(buf)
    } catch {
      return ""
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) {
    try {
      return Buffer.from(stored.slice(PLAIN_PREFIX.length), "base64").toString(
        "utf8",
      )
    } catch {
      return ""
    }
  }
  // Legacy/plain value written before sealing existed.
  return stored
}

export function encryptionAvailable(): boolean {
  return available()
}
