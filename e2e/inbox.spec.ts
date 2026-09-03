import { expect, test } from "@playwright/test"
import { closeApp, launchApp, type LaunchedApp } from "./helpers"

let launched: LaunchedApp

test.afterEach(async () => {
  await closeApp(launched)
})

test("agent inbox opens on Alt+Shift+I and shows the clear state", async () => {
  launched = await launchApp([{ id: "s1", title: "Quiet session" }])
  const { page } = launched

  await page.keyboard.press("Alt+Shift+KeyI")
  await expect(page.locator(".inbox-empty")).toContainText("All clear")
  await page.keyboard.press("Escape")
  await expect(page.locator(".inbox-empty")).toHaveCount(0)
})
