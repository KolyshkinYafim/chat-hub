import { expect, test } from "@playwright/test"
import { closeApp, launchApp, type LaunchedApp } from "./helpers"

for (const provider of ["codex", "claude"] as const) {
  test(`LIVE-${provider} UI reply, native follow-up and renderer reload`, async ({ browserName: _browserName }, testInfo) => {
    test.skip(process.env.CHAT_HUB_LIVE_UI !== "1", "Requires authenticated local CLIs and provider quota")
    test.setTimeout(150_000)
    let launched: LaunchedApp | undefined
    try {
      launched = await launchApp([{ id: "fixture", title: "QA fixture" }])
      const { page, workDir } = launched
      const session = await page.evaluate(async ({ provider, workDir }) => {
        await window.chatHub.setPermissionMode("default")
        await window.chatHub.setGeneralConfig({ defaultEffort: "low", completionSound: false })
        return window.chatHub.createSession({ provider, cwd: workDir, title: `${provider} live QA`, project: "e2e" })
      }, { provider, workDir })
      await page.locator(".session-row", { hasText: `${provider} live QA` }).click()
      const composer = page.locator("textarea").first()
      await composer.fill("Do not use tools. Remember the codeword ORBIT742. Reply with exactly ORBIT742.")
      await composer.press("Enter")
      await expect(page.locator(".turn.turn-assistant").last()).toContainText("ORBIT742", { timeout: 60_000 })
      const waitDone = async () => {
        await expect.poll(async () => page.evaluate(async id => {
          const snapshot = await window.chatHub.getSnapshot([id])
          return snapshot.sessions.find(s => s.id === id)?.status
        }, session.id), { timeout: 30_000 }).toMatch(/^(done|idle|waiting_input)$/)
      }
      await waitDone()
      await composer.fill("Do not use tools. What codeword did I ask you to remember? Reply with only that codeword.")
      await composer.press("Enter")
      await expect(page.locator(".turn.turn-user")).toHaveCount(2)
      await expect(page.locator(".turn.turn-assistant")).toHaveCount(2, { timeout: 60_000 })
      await expect(page.locator(".turn.turn-assistant").last()).toContainText("ORBIT742", { timeout: 60_000 })
      await waitDone()
      await page.reload()
      await page.locator(".session-row", { hasText: `${provider} live QA` }).click()
      await expect(page.locator(".turn.turn-user")).toHaveCount(2)
      await expect(page.locator(".turn.turn-assistant").last()).toContainText("ORBIT742")
      const screenshot = testInfo.outputPath(`${provider}-live.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`${provider}-live`, { path: screenshot, contentType: "image/png" })
    } finally {
      if (launched) await closeApp(launched)
    }
  })
}
