import { expect, test } from "@playwright/test"
import { closeApp, launchApp, type LaunchedApp } from "./helpers"

let launched: LaunchedApp

test.afterEach(async () => {
  await closeApp(launched)
})

test("boots into the seeded session list", async () => {
  launched = await launchApp([
    { id: "s1", title: "Fix webhook retries" },
    { id: "s2", title: "Tune reward curve" },
    { id: "s3", title: "Ship the boot skeleton" },
  ])
  const { page } = launched
  await expect(page.locator(".session-row")).toHaveCount(3)
  await expect(
    page.locator(".session-row", { hasText: "Fix webhook retries" }),
  ).toBeVisible()
  expect(await page.title()).toContain("Chat Hub")
})

test("boots clean with no sessions and shows the empty state", async () => {
  launched = await launchApp([])
  const { page } = launched
  await expect(page.locator(".session-row")).toHaveCount(0)
  await expect(page.locator("body")).toContainText("⌘N")
})
