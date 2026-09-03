import { expect, test } from "@playwright/test"
import { closeApp, launchApp, type LaunchedApp } from "./helpers"

let launched: LaunchedApp

test.afterEach(async () => {
  await closeApp(launched)
})

test("archives instantly and restores through the undo toast", async () => {
  launched = await launchApp([
    { id: "s1", title: "Keep me around" },
    { id: "s2", title: "Archive me" },
  ])
  const { page } = launched

  const row = page.locator(".session-row", { hasText: "Archive me" })
  await row.hover()
  await row.locator('[title^="Archive session"]').click()

  await expect(page.locator(".session-row", { hasText: "Archive me" })).toHaveCount(0)
  const toast = page.locator(".toast", { hasText: "Archived" })
  await expect(toast).toBeVisible()
  await toast.locator(".toast-action").click()
  await expect(
    page.locator(".session-row", { hasText: "Archive me" }),
  ).toBeVisible()
})
