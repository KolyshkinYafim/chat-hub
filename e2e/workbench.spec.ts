import { expect, test } from "@playwright/test"
import { closeApp, launchApp } from "./helpers"

test("integration warnings are compact, readable and never cover a successful reply", async () => {
  const launched = await launchApp([{ id: "notices", title: "Review workspace" }], {
    notices: [{ id: "answer", sessionId: "notices", role: "assistant", content: "The workspace is ready.", createdAt: Date.now(), items: [
      { id: "codex-mcp-figma", kind: "notice", level: "warning", status: "failed", title: "Figma needs authentication", detail: "Run codex mcp login figma", source: "figma" },
      { id: "command", kind: "command", command: "node --test", output: "1 passed", status: "completed", exitCode: 0 },
    ] }],
  })
  try {
    const { page } = launched
    await page.locator(".session-row").click()
    await expect(page.locator(".turn.turn-assistant")).toContainText("The workspace is ready.")
    await expect(page.locator(".provider-notices")).not.toHaveAttribute("open")
    await expect(page.locator(".activity-notice")).toHaveCount(0)
    await expect(page.locator(".warn-banner")).toHaveCount(0)
    await page.locator(".provider-notices > summary").click()
    await expect(page.locator(".provider-notices-list")).toContainText("codex mcp login figma")
    await page.locator(".turn-activity-toggle").click()
    await expect(page.locator(".turn-timeline-count")).toHaveText("1/1")
    await expect(page.locator(".turn-timeline-failed")).toHaveCount(0)
    expect(await page.locator(".turn-timeline").evaluate(el => getComputedStyle(el).position)).not.toBe("sticky")
    await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Session actions", exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "Rename session" })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Open in editor" })).toBeVisible()
  } finally { await closeApp(launched) }
})

test("long tool commands stay inside the chat and their output scrolls independently", async () => {
  const longCommand = `git show --stat ${"very-long-reference-".repeat(60)}`
  const launched = await launchApp([{ id: "overflow", title: "Long command layout" }], {
    overflow: [{ id: "long-answer", sessionId: "overflow", role: "assistant", content: "Inspecting the workspace.", createdAt: Date.now(), streaming: true, items: [
      { id: "long-command", kind: "command", command: longCommand, output: Array.from({ length: 100 }, (_, i) => `${i}: ${"output-".repeat(80)}`).join("\n"), status: "running" },
    ] }],
  })
  try {
    const { page, app } = launched
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800))
    await page.locator(".session-row").click()
    const activity = page.locator(".turn-activity")
    if (await activity.getAttribute("open") === null) await activity.locator(":scope > summary").click()
    await page.locator(".activity-command > summary").click()
    await expect(page.locator(".activity-output")).toBeVisible()
    for (const width of [1000, 1400]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
      await expect.poll(() => page.locator(".transcript").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      const chips = await page.locator(".composer-chips").boundingBox()
      const actions = await page.locator(".composer-actions").boundingBox()
      expect(chips!.x + chips!.width <= actions!.x + 1 || chips!.y + chips!.height <= actions!.y + 1).toBe(true)
      const transcript = await page.locator(".transcript").boundingBox()
      for (const selector of [".turn-activity", ".turn-timeline", ".activity-command", ".activity-output"]) {
        const box = await page.locator(selector).boundingBox()
        expect(box!.x + box!.width).toBeLessThanOrEqual(transcript!.x + transcript!.width + 1)
      }
      const output = page.locator(".activity-output")
      expect(await output.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
      expect(await output.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
      const before = await page.locator(".transcript").evaluate(el => el.scrollTop)
      await output.evaluate(el => { el.scrollTop = 80; el.scrollLeft = 120 })
      expect(await output.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
      expect(await output.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)
      expect(await page.locator(".transcript").evaluate(el => el.scrollTop)).toBe(before)
    }
  } finally { await closeApp(launched) }
})
