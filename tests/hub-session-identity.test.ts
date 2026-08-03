import { describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const HOOK = join(
  __dirname,
  "../../session-monitor/hooks/agent-desktop-claude-hook.py",
)

/**
 * The Hub and the globally-installed Claude Code hook both watch the same
 * spawned `claude`. These assert the two halves of the agreement that keeps
 * one turn from raising two island cards. The Swift side has no say here — it
 * just renders whatever id it is given.
 */
describe("hub ↔ hook session identity", () => {
  it("the hook adopts the Hub's session id when the Hub names one", async () => {
    const src = await readFile(HOOK, "utf8")
    expect(src).toContain('os.environ.get("AGENT_DESKTOP_HUB_SESSION")')
    // Both the card and its permission requests must land on the same id.
    const uses = src.match(/AGENT_DESKTOP_HUB_SESSION/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(2)
  })

  it("the hook labels a Hub-spawned session as hub, not terminal", async () => {
    const src = await readFile(HOOK, "utf8")
    expect(src).toContain('"source": "hub" if hub_sid else "terminal"')
    expect(src).toContain('os.environ.get("AGENT_DESKTOP_HUB_BUNDLE")')
  })

  it("the Hub passes both variables to every turn it spawns", async () => {
    const src = await readFile(join(__dirname, "../src/main/session-manager.ts"), "utf8")
    expect(src).toContain("AGENT_DESKTOP_HUB_SESSION: session.id")
    expect(src).toContain("AGENT_DESKTOP_HUB_BUNDLE")
    expect(src).toContain("hookIdentityEnv(session)")
  })

  it("the Hub stamps source on every upsert it publishes", async () => {
    const src = await readFile(join(__dirname, "../src/main/session-manager.ts"), "utf8")
    expect(src).toContain('source: "hub"')
  })
})
