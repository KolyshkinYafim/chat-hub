const PATH_IN_QUOTES = /'([^']+)'/

type Rule = {
  match: RegExp
  say: (path: string | null) => string
}

function tail(path: string | null): string {
  if (!path) return "this file"
  const name = path.split("/").filter(Boolean).pop()
  return name ? `“${name}”` : "this file"
}

/**
 * macOS answers a read of an evicted iCloud file with EDEADLK, which libuv has
 * no name for — the surfaces used to show the raw "Unknown system error -11".
 * The rest are the codes a workspace file can realistically produce; anything
 * unrecognised is returned untouched rather than dressed up as something known.
 */
const RULES: Rule[] = [
  {
    match: /Unknown system error -11|EDEADLK/,
    say: (p) =>
      `${tail(p)} is in iCloud and has not been downloaded to this Mac. Open its folder in Finder to fetch it, then try again.`,
  },
  {
    match: /\bENOENT\b/,
    say: (p) => `${tail(p)} is not there any more.`,
  },
  {
    match: /\bEACCES\b|\bEPERM\b/,
    say: (p) => `No permission to read ${tail(p)}.`,
  },
  {
    match: /\bEISDIR\b/,
    say: (p) => `${tail(p)} is a folder, not a file.`,
  },
  {
    match: /\bENOTDIR\b/,
    say: (p) => `Part of the path to ${tail(p)} is not a folder.`,
  },
  {
    match: /\bENOSPC\b/,
    say: () => "The disk is full, so the write did not happen.",
  },
  {
    match: /\bEROFS\b/,
    say: (p) => `${tail(p)} is on a read-only volume.`,
  },
  {
    match: /\bEMFILE\b|\bENFILE\b/,
    say: () => "Too many files are open right now. Try again in a moment.",
  },
]

/** Turn a filesystem failure into a sentence that says what to do about it. */
export function humanizeFsError(message: string): string {
  const path = message.match(PATH_IN_QUOTES)?.[1] ?? null
  for (const rule of RULES) {
    if (rule.match.test(message)) return rule.say(path)
  }
  return message
}
