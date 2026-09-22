import { expect } from "@playwright/test"

export async function showChanges(page) {
  await page.getByRole("button", { name: "Changes", exact: true }).click()
  const exit = page.getByRole("button", { name: "Exit focus", exact: true })
  if (await exit.count()) await exit.click()
  await page.locator('.scm-row-main[title="sum.mjs"]').click()
  await expect(page.locator(".scm-diff")).toContainText("a + b")
  await page.getByRole("button", { name: "Focus diff", exact: true }).click()
}
