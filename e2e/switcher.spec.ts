import { expect, test } from "@playwright/test"
import { closeApp, launchApp, type LaunchedApp } from "./helpers"

let launched: LaunchedApp

test.afterEach(async () => {
  await closeApp(launched)
})

test("held Ctrl+Tab cycles sessions and commits on release", async () => {
  launched = await launchApp([
    { id: "s1", title: "First session" },
    { id: "s2", title: "Second session" },
  ])
  const { page } = launched

  await page.locator(".session-row", { hasText: "First session" }).click()
  await expect(
    page.locator(".session-row.active", { hasText: "First session" }),
  ).toBeVisible()

  await page.keyboard.down("Control")
  await page.keyboard.press("Tab")
  await expect(page.getByLabel("Session switcher")).toBeVisible()
  await page.keyboard.up("Control")

  await expect(page.getByLabel("Session switcher")).toHaveCount(0)
  await expect(
    page.locator(".session-row.active", { hasText: "Second session" }),
  ).toBeVisible()
})
