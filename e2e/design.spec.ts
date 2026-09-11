import { cp, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { closeApp, launchApp, type LaunchedApp } from "./helpers"

let launched: LaunchedApp | undefined

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  launched = undefined
})

test("selects, fits and exports a local artboard through the desktop bridge", async ({ browserName: _browserName }, testInfo) => {
  launched = await launchApp([{ id: "design-review", title: "Review the product design" }])
  const { page, app, workDir } = launched
  await cp(resolve("fixtures/design"), join(workDir, "design"), { recursive: true })
  await page.locator(".session-row", { hasText: "Review the product design" }).click()
  await page.keyboard.press("Meta+b")
  await page.locator(".surface-tab[title='Design']").click()

  const picker = page.getByRole("combobox", { name: "Select artboard" })
  await expect(picker).toBeVisible()
  await expect(picker.locator("option")).toHaveCount(4)
  await expect(page.getByRole("button", { name: "Export HTML", exact: true })).toBeDisabled()
  await picker.selectOption("dashboard.dc.html")
  await expect(page.locator(".design-artboard.is-selected iframe")).toHaveAttribute("title", "Dashboard")
  await expect(page.locator(".design-artboard.is-selected iframe")).toHaveAttribute("sandbox", "")

  const exported = join(workDir, "exported-dashboard.html")
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, exported)
  await page.getByRole("button", { name: "Export HTML", exact: true }).click()
  await expect.poll(async () => {
    try { return await readFile(exported, "utf8") } catch { return "" }
  }).toBe(await readFile(join(workDir, "design", "dashboard.dc.html"), "utf8"))

  const screenshot = testInfo.outputPath("design-workspace.png")
  await page.screenshot({ path: screenshot })
  await testInfo.attach("design-workspace", { path: screenshot, contentType: "image/png" })
  await page.getByRole("button", { name: "Fit", exact: true }).click()
  await expect(picker).toHaveValue("")
  await expect(page.locator(".design-artboard.is-selected")).toHaveCount(0)
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(picker.locator("option")).toHaveCount(4)
})

test("explains a missing Figma key and returns to local artboards", async () => {
  launched = await launchApp([{ id: "design-fallback", title: "Design without a key" }])
  const { page } = launched
  await page.locator(".session-row", { hasText: "Design without a key" }).click()
  await page.keyboard.press("Meta+b")
  await page.locator(".surface-tab[title='Design']").click()
  await page.getByRole("textbox", { name: "Figma frame URL" }).fill("https://www.figma.com/design/AbC123/Frame?node-id=1-2")
  await page.getByRole("button", { name: "Open frame", exact: true }).click()
  await expect(page.getByText("Frame preview unavailable", { exact: true })).toBeVisible()
  await expect(page.locator(".design-empty-hint")).toContainText("FIGMA_API_KEY")
  await page.getByRole("button", { name: "Local artboards", exact: true }).click()
  await expect(page.getByText("No artboards", { exact: true })).toBeVisible()
})
