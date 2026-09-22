import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { closeApp, launchApp } from "./helpers"

for (const provider of ["codex", "claude"] as const) {
  test(`TOOLS-${provider} executes a real workspace command through the agent`, async () => {
    test.skip(process.env.CHAT_HUB_LIVE_UI !== "1", "Requires authenticated CLI and quota")
    test.setTimeout(120_000)
    const launched = await launchApp([{ id: "fixture", title: "QA fixture" }])
    try {
      const { page, workDir } = launched
      const session = await page.evaluate(async ({ provider, workDir }) => {
        await window.chatHub.setPermissionMode("acceptEdits")
        await window.chatHub.setGeneralConfig({ defaultEffort: "low", completionSound: false })
        return window.chatHub.createSession({ provider, cwd: workDir, title: `${provider} tool QA`, project: "e2e" })
      }, { provider, workDir })
      await page.locator(".session-row", { hasText: `${provider} tool QA` }).click()
      const input = page.locator(".composer-shell textarea")
      await input.fill("Use your shell/terminal tool to run exactly: node -e \"require('fs').writeFileSync('provider-tool.txt', 'TOOL_OK'); console.log('TOOL_OK')\". Do not use any external services. Then briefly report the result. You must actually execute the command, not just describe it.")
      await input.press("Enter")
      let approved = false
      await expect.poll(async () => {
        const allow = page.locator(".permission-banner").getByRole("button", { name: "Allow", exact: true })
        if (await allow.count()) { await allow.first().click(); approved = true }
        try { return await readFile(join(workDir, "provider-tool.txt"), "utf8") } catch { return "" }
      }, { timeout: 80_000, intervals: [500] }).toBe("TOOL_OK")
      if (provider === "claude") expect(approved).toBe(true)
      await expect.poll(async () => page.evaluate(async id => {
        const snap = await window.chatHub.getSnapshot([id])
        return snap.sessions.find(s => s.id === id)?.status
      }, session.id), { timeout: 30_000 }).toBe("done")
      const snapshot = await page.evaluate(id => window.chatHub.getSnapshot([id]), session.id)
      const items = snapshot.messages[session.id].flatMap(message => message.items ?? [])
      expect(items.some(item => (item.kind === "command" || item.kind === "tool") && item.status === "completed")).toBe(true)
      expect(items.filter(item => item.kind === "notice").map(item => item.title).join("\n")).not.toContain("Code Mode is unavailable")
      await expect(page.locator(".turn.turn-assistant").last()).not.toHaveText("")
    } finally { await closeApp(launched) }
  })
}

test("TOOLS-claude Deny prevents a real command from creating its file", async () => {
  test.skip(process.env.CHAT_HUB_LIVE_UI !== "1", "Requires authenticated CLI and quota")
  test.setTimeout(100_000)
  const launched = await launchApp([{ id: "fixture", title: "QA fixture" }])
  try {
    const { page, workDir } = launched
    const session = await page.evaluate(async cwd => {
      await window.chatHub.setPermissionMode("default")
      return window.chatHub.createSession({ provider: "claude", cwd, title: "Claude deny QA" })
    }, workDir)
    await page.locator(".session-row", { hasText: "Claude deny QA" }).click()
    const input = page.locator(".composer-shell textarea")
    await input.fill("Attempt exactly this shell command once: node -e \"require('fs').writeFileSync('denied.txt', 'should not exist')\". If permission is denied, stop immediately, do not retry or use another tool, and report that it was denied.")
    await input.press("Enter")
    await page.locator(".permission-banner").getByRole("button", { name: "Deny", exact: true }).click({ timeout: 60_000 })
    await expect.poll(async () => page.evaluate(async id => (await window.chatHub.getSnapshot([id])).sessions.find(s => s.id === id)?.status, session.id), { timeout: 30_000 }).toBe("done")
    await expect(readFile(join(workDir, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally { await closeApp(launched) }
})
