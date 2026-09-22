import { readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { closeApp, launchApp, type LaunchedApp } from "./helpers"

let launched: LaunchedApp | undefined

test.afterEach(async () => {
  if (launched) await closeApp(launched)
  launched = undefined
})

async function openTerminal(page: Page, title?: string) {
  await (title ? page.locator(".session-row", { hasText: title }) : page.locator(".session-row").first()).click()
  await page.keyboard.press(process.platform === "darwin" ? "Meta+b" : "Control+b")
  await page.locator(".surface-tab[title='Terminal']").click()
  await expect(page.locator(".xterm-helper-textarea")).toBeAttached()
}

async function command(page: Page, value: string) {
  const input = page.locator(".xterm-helper-textarea")
  await expect(input).toHaveCount(1)
  await input.focus()
  await input.pressSequentially(value)
  await input.press("Enter")
}

test("TERM-01 UI input reaches a real shell in the session workspace", async ({ browserName: _browserName }, testInfo) => {
  launched = await launchApp([{ id: "terminal", title: "Terminal workspace QA" }])
  const { page, workDir } = launched
  await openTerminal(page)
  await command(page, "printf 'QA_%s\\n' EXECUTED; pwd -P > qa-cwd.txt")
  await expect(page.locator(".xterm-rows")).toContainText("QA_EXECUTED")
  await expect.poll(async () => {
    try { return (await readFile(join(workDir, "qa-cwd.txt"), "utf8")).trim() } catch { return "" }
  }).toBe(await realpath(workDir))
  await page.screenshot({ path: testInfo.outputPath("terminal-workspace.png") })
})

test("TERM-02 Ctrl+C interrupts a running command and accepts the next command", async () => {
  launched = await launchApp([{ id: "interrupt", title: "Interrupt QA" }])
  const { page } = launched
  await openTerminal(page)
  await command(page, "printf 'QA_%s\\n' STARTED; sleep 30")
  await expect(page.locator(".xterm-rows")).toContainText("QA_STARTED")
  await page.locator(".xterm-helper-textarea").press("Control+c")
  await command(page, "printf 'QA_%s\\n' RECOVERED")
  await expect(page.locator(".xterm-rows")).toContainText("QA_RECOVERED", { timeout: 5000 })
})

test("TERM-03 shell exit is visible and Restart shell restores input", async () => {
  launched = await launchApp([{ id: "restart", title: "Restart QA" }])
  const { page } = launched
  await openTerminal(page)
  await command(page, "exit 7")
  await expect(page.locator(".surface-terminal-status")).toContainText("Shell exited (7)")
  await page.getByRole("button", { name: "Restart shell", exact: true }).click()
  await command(page, "printf 'QA_%s\\n' RESTARTED")
  await expect(page.locator(".xterm-rows")).toContainText("QA_RESTARTED")
  await expect(page.locator(".surface-terminal-status")).toHaveCount(0)
})

test("TERM-04 installed Codex and Claude Code are reachable inside the UI terminal", async ({ browserName: _browserName }, testInfo) => {
  test.skip(process.env.CHAT_HUB_LOCAL_CLIS !== "1", "Requires locally installed Codex and Claude Code")
  launched = await launchApp([{ id: "cli", title: "Codex + Claude Code terminal QA" }])
  const { page, workDir } = launched
  await openTerminal(page)
  await command(page, "codex --version > codex-version.txt && claude --version > claude-version.txt && printf 'QA_%s\\n' CLIS_OK")
  await expect(page.locator(".xterm-rows")).toContainText("QA_CLIS_OK", { timeout: 20_000 })
  const codex = await readFile(join(workDir, "codex-version.txt"), "utf8")
  const claude = await readFile(join(workDir, "claude-version.txt"), "utf8")
  expect(codex).toContain("codex-cli")
  expect(claude).toContain("Claude Code")
  await testInfo.attach("cli-versions", { body: `${codex}${claude}`, contentType: "text/plain" })
})

test("TERM-05 shell PID, environment and background output survive panels and sessions", async () => {
  launched = await launchApp([{ id: "keep", title: "Persistent shell" }, { id: "other", title: "Other work" }])
  const { page, workDir } = launched
  await openTerminal(page, "Persistent shell")
  await command(page, "export QA_KEEP=RETAINED; echo $$ > before.pid; (sleep 1; printf 'QA_%s\\n' BACKGROUND) &")
  await expect.poll(async () => { try { return await readFile(join(workDir, "before.pid"), "utf8") } catch { return "" } }).not.toBe("")
  await page.locator(".surface-tab[title='Files']").click()
  await page.locator(".session-row", { hasText: "Other work" }).click()
  await page.locator(".session-row", { hasText: "Persistent shell" }).click()
  if (!(await page.locator(".surface-tab[title='Terminal']").isVisible())) await page.locator(".panel-toggle").click()
  await page.locator(".surface-tab[title='Terminal']").click()
  await expect(page.locator(".xterm-rows")).toContainText("QA_BACKGROUND")
  await command(page, "echo $$ > after.pid; printf 'QA_%s\\n' \"$QA_KEEP\"")
  await expect(page.locator(".xterm-rows")).toContainText("QA_RETAINED")
  expect(await readFile(join(workDir, "after.pid"), "utf8")).toBe(await readFile(join(workDir, "before.pid"), "utf8"))
  await page.getByRole("button", { name: "Stop terminal", exact: true }).click()
  await expect(page.locator(".surface-terminal-status")).toContainText("Terminal stopped")
  await page.getByRole("button", { name: "Restart shell", exact: true }).click()
  await command(page, "printf 'QA_%s\\n' \"${QA_KEEP:-FRESH}\"")
  await expect(page.locator(".xterm-rows")).toContainText("QA_FRESH")
})
