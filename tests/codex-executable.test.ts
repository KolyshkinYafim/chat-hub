import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveCodexExecutable } from "../src/main/codex-protocol/client"

describe("Codex companion executable discovery", () => {
  it("launches the bundle target rather than the Homebrew symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-layout-"))
    try {
      mkdirSync(join(root, "bundle"))
      const target = join(root, "bundle", "codex")
      writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      writeFileSync(join(root, "bundle", "codex-code-mode-host"), "host")
      const alias = join(root, "codex")
      symlinkSync(target, alias)
      expect(resolveCodexExecutable(alias)).toBe(realpathSync(target))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it("preserves missing executable errors for the spawn layer", () => {
    expect(resolveCodexExecutable("/missing/chat-hub/codex")).toBe("/missing/chat-hub/codex")
  })
})
