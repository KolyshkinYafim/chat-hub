import { expect, test } from "@playwright/test"
import { closeApp, launchApp, type LaunchedApp } from "./helpers"

let launched: LaunchedApp

test.afterEach(async () => {
  await closeApp(launched)
})

test("palette jumps to a session by fuzzy title", async () => {
  launched = await launchApp([
    { id: "s1", title: "Fix webhook retries" },
    { id: "s2", title: "Tune reward curve" },
  ])
  const { page } = launched

  await expect(page.locator(".session-row")).toHaveCount(2)
  await page.keyboard.press("Meta+k")
  const input = page.getByPlaceholder(/Jump to session/)
  await expect(input).toBeVisible()
  await input.fill("reward")
  await input.press("Enter")
  await expect(
    page.locator(".session-row.active", { hasText: "Tune reward curve" }),
  ).toBeVisible()
})

test("palette opens a second window via the New Window command", async () => {
  launched = await launchApp([{ id: "s1", title: "Solo session" }])
  const { page, app } = launched

  await expect(page.locator(".session-row")).toHaveCount(1)
  await page.keyboard.press("Meta+k")
  const input = page.getByPlaceholder(/Jump to session/)
  await expect(input).toBeVisible()
  await input.fill("new window")
  const windowPromise = app.waitForEvent("window")
  await input.press("Enter")
  const second = await windowPromise
  await second.waitForLoadState("domcontentloaded")
  expect(app.windows().length).toBe(2)
})
