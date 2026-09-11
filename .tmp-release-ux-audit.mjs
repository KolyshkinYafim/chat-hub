import { _electron as electron } from "@playwright/test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const root = process.cwd()
const appImage = resolve(root, "release/Chat Hub-0.1.0.AppImage")
const userData = await mkdtemp(join(tmpdir(), "chat-hub-coding-audit-"))
const workDir = await mkdtemp(join(tmpdir(), "chat-hub-coding-project-"))
execFileSync("git", ["init", "--quiet", workDir])

const env = {
  ...process.env,
  CHAT_HUB_USER_DATA: userData,
  CHAT_HUB_SOCKET: join(userData, "hub.sock"),
  CHATHUB_BROWSER_SOCKET: join(userData, "browser.sock"),
  AGENT_DESKTOP_EVENTS: join(userData, "events.jsonl"),
  AGENT_DESKTOP_COMMANDS: join(userData, "commands.jsonl"),
  AGENT_DESKTOP_SOCKET: join(userData, "monitor.sock"),
}
delete env.ELECTRON_RENDERER_URL

const consoleErrors = []
const pageErrors = []
const app = await electron.launch({ executablePath: appImage, env })
const page = await app.firstWindow()
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text())
})
page.on("pageerror", (error) => pageErrors.push(error.message))

async function filesDigest() {
  const rows = []
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue
      const path = join(dir, entry.name)
      const rel = join(prefix, entry.name)
      if (entry.isDirectory()) await walk(path, rel)
      else if (entry.isFile()) {
        const body = await readFile(path)
        rows.push(`${rel}:${createHash("sha256").update(body).digest("hex")}`)
      }
    }
  }
  await walk(workDir)
  return rows.sort()
}

async function setMode(name) {
  await page.locator(".session-mode-trigger").click()
  const option = page.locator(".session-mode-option").filter({ hasText: name }).first()
  await option.waitFor({ state: "visible" })
  await option.click()
  await page.waitForTimeout(300)
  return (await page.locator(".session-mode-trigger").innerText()).replace(/\s+/g, " ").trim()
}

async function runTurn(prompt) {
  const assistants = page.locator(".turn.turn-assistant")
  const before = await assistants.count()
  const composer = page.locator("textarea").first()
  await composer.fill(prompt)
  await composer.press("Enter")
  const deadline = Date.now() + 180_000
  let approvals = 0
  while (Date.now() < deadline) {
    const allow = page.getByRole("button", { name: "Allow", exact: true }).last()
    if (await allow.isVisible().catch(() => false)) {
      await allow.click()
      approvals += 1
    }
    const hasReply = (await assistants.count()) > before
    const stopVisible = await page
      .getByRole("button", { name: /Stop/ })
      .isVisible()
      .catch(() => false)
    const activeLive = await page
      .locator(".session-row.active.live")
      .isVisible()
      .catch(() => false)
    if (hasReply && !stopVisible && !activeLive) {
      await page.waitForTimeout(500)
      return {
        approvals,
        reply: (await assistants.last().innerText()).replace(/\s+/g, " ").trim(),
      }
    }
    await page.waitForTimeout(500)
  }
  throw new Error(`Turn timed out: ${prompt}`)
}

try {
  await page.waitForLoadState("domcontentloaded")
  await page.setViewportSize({ width: 1500, height: 900 })
  const skip = page.getByRole("button", { name: "Skip", exact: true })
  if (await skip.isVisible().catch(() => false)) await skip.click()

  await page.keyboard.press("Control+N")
  await page.locator(".ns-search").waitFor({ state: "visible" })
  await page.locator(".ns-search").fill(workDir)
  await page.locator(".ns-pick").first().waitFor({ state: "visible" })
  const codex = page.locator(".ns-agent").filter({ hasText: "Codex" }).first()
  await codex.waitFor({ state: "visible", timeout: 30_000 })
  await codex.click()
  await page.locator(".ns-options summary").click()
  const model = await page.locator(".ns-options select").nth(1).inputValue()
  await page.getByRole("button", { name: "Start chat", exact: true }).click()
  await page.locator(".session-mode-trigger").waitFor({ state: "visible", timeout: 30_000 })

  const codeMode = await setMode("Code")
  const code = await runTurn(
    "Create calculator.js exporting add(a, b), plus calculator.test.js using node:test. Run node --test. Keep it minimal and do not install anything.",
  )
  const afterCode = await filesDigest()
  const titleAfterCode = (await page.locator(".topbar-title").innerText()).trim()

  await page.getByTitle(/Open project tools/).click()
  await page.locator(".surface-tab-label", { hasText: "Changes" }).click()
  await page.waitForTimeout(800)
  const changesText = (await page.locator(".surface-dock").innerText()).replace(/\s+/g, " ").trim()
  await page.locator(".surface-tab-label", { hasText: "Terminal" }).click()
  await page.locator(".xterm").waitFor({ state: "visible", timeout: 15_000 })
  const terminalVisible = await page.locator(".xterm").isVisible()
  await page.getByTitle(/Close project tools/).click()
  await page.screenshot({ path: "/tmp/chat-hub-coding-wide.png", fullPage: true })

  const planMode = await setMode("Plan")
  const beforePlan = await filesDigest()
  const plan = await runTurn("Plan how to add subtraction. Do not edit or create files; answer with a short numbered plan.")
  const planClean = JSON.stringify(beforePlan) === JSON.stringify(await filesDigest())

  const reviewMode = await setMode("Review")
  const beforeReview = await filesDigest()
  const review = await runTurn("Review the calculator implementation for bugs and missing edge cases. Do not edit files.")
  const reviewClean = JSON.stringify(beforeReview) === JSON.stringify(await filesDigest())

  const askMode = await setMode("Ask")
  const beforeAsk = await filesDigest()
  const ask = await runTurn("In one sentence, explain what this project currently does. Do not edit files.")
  const askClean = JSON.stringify(beforeAsk) === JSON.stringify(await filesDigest())

  await page.locator(".session-mode-trigger").click()
  const modeOptions = (await page.locator(".session-mode-option").allInnerTexts()).map((text) =>
    text.replace(/\s+/g, " ").trim(),
  )
  await page.screenshot({ path: "/tmp/chat-hub-modes-wide.png", fullPage: true })
  await page.keyboard.press("Escape")

  await page.setViewportSize({ width: 1024, height: 720 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: "/tmp/chat-hub-coding-compact.png", fullPage: true })

  const duplicateSignals = {
    systemBanners: await page.locator(".system-banner").count(),
    modeTriggers: await page.locator(".session-mode-trigger").count(),
    topbarOpenButtons: await page.locator(".topbar").getByRole("button", { name: /^Open/ }).count(),
    topbarRenameButtons: await page.locator(".topbar").getByRole("button", { name: /Rename/ }).count(),
  }

  console.log(
    JSON.stringify(
      {
        appUrl: page.url(),
        userData,
        workDir,
        project: basename(workDir),
        model,
        modes: { codeMode, planMode, reviewMode, askMode, modeOptions },
        code: { ...code, files: afterCode, titleAfterCode },
        plan: { ...plan, filesUnchanged: planClean },
        review: { ...review, filesUnchanged: reviewClean },
        ask: { ...ask, filesUnchanged: askClean },
        surfaces: { terminalVisible, changesText: changesText.slice(0, 500) },
        duplicateSignals,
        consoleErrors,
        pageErrors,
      },
      null,
      2,
    ),
  )
} finally {
  await app.close()
}
