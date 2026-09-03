import { expect, test } from "@playwright/test"
import { closeApp, launchApp, type LaunchedApp } from "./helpers"

let launched: LaunchedApp

test.afterEach(async () => {
  await closeApp(launched)
})

test("sends a message and streams the mock reply to done", async () => {
  launched = await launchApp([{ id: "s1", title: "Chat with the mock" }])
  const { page } = launched

  await page.locator(".session-row", { hasText: "Chat with the mock" }).click()
  const composer = page.locator("textarea").first()
  await composer.click()
  await composer.fill("hello agent")
  await composer.press("Enter")

  await expect(page.locator(".turn.turn-user")).toContainText("hello agent")
  await expect(page.locator(".turn.turn-assistant")).toHaveCount(1, {
    timeout: 15_000,
  })
  await expect(page.locator(".turn.turn-assistant").last()).not.toHaveText("", {
    timeout: 15_000,
  })
  await expect(
    page.locator(".session-row", { hasText: "Chat with the mock" }),
  ).not.toHaveClass(/live/, { timeout: 20_000 })
})
