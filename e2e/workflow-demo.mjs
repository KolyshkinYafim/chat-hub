import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron, expect } from "@playwright/test"
import { sessionMetas, writeSeedData } from "./seed.mjs"
import { showChanges } from "./showcase-view.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const live = process.argv.includes("--live")
const once = process.argv.includes("--once")
const output = join(root, "output", "showcase", new Date().toISOString().replaceAll(":", "-"))
await mkdir(output, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), "chat-hub-showcase-"))
const workDir = await realpath(await mkdtemp(join(tmpdir(), "chat-hub-demo-project-")))
const now = Date.now()
await writeSeedData(userData, sessionMetas([{ id: "terminal", title: "01 · Terminal", project: "Demo project" }], workDir, now), workDir, now)
await writeFile(join(userData, "data", "settings.json"), JSON.stringify({ version: 2, permissionMode: "acceptEdits", providers: {}, instances: [], mcpEnv: {}, general: { onboarded: true, completionSound: false } }))
await writeFile(join(workDir, "sum.mjs"), "export const sum = (a, b) => a - b\n")
await writeFile(join(workDir, "sum.test.mjs"), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { sum } from './sum.mjs'\ntest('adds positive numbers', () => assert.equal(sum(2, 3), 5))\ntest('handles zero', () => assert.equal(sum(4, 0), 4))\n")
await writeFile(join(workDir, "README.md"), "# Chat Hub · live workflow\n\nA small, isolated project for watching Codex fix a test and Claude review it.\nRun: node --test\n")
await writeFile(join(workDir, ".gitignore"), ".chathub/\n.mcp.json\n.codex/\n*.pid\n")
const git = args => execFileSync("git", args, { cwd: workDir, stdio: "ignore" })
git(["init", "-b", "main"]); git(["add", "."]); git(["-c", "user.name=Chat Hub Demo", "-c", "user.email=demo@localhost", "commit", "-m", "Seed arithmetic demo"])
const executablePath = process.env.CHAT_HUB_E2E_EXECUTABLE
const app = await _electron.launch({
  ...(executablePath ? { executablePath } : {}),
  args: executablePath ? [] : [join(root, "out", "main", "index.js")], cwd: root,
  env: { ...process.env, CHAT_HUB_USER_DATA: userData, CHAT_HUB_DEMO: "0", CHAT_HUB_COCKPIT: "0", CHAT_HUB_SELFTEST: "0", AGENT_DESKTOP_EVENTS: join(userData, "agent-desktop", "events.jsonl"), AGENT_DESKTOP_COMMANDS: join(userData, "agent-desktop", "commands.jsonl"), AGENT_DESKTOP_SOCKET: "", CHAT_HUB_SOCKET: "", CHATHUB_BROWSER_SOCKET: "" },
})
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.setBounds({ x: 50, y: 50, width: 1440, height: 920 }); win.show(); win.focus()
})
await app.context().tracing.start({ screenshots: true, snapshots: true })
let step = 0
async function stage(text) {
  console.log(`${++step}. ${text}`)
  await page.evaluate(label => {
    let bar = document.getElementById("workflow-demo-caption")
    if (!bar) {
      bar = document.createElement("div"); bar.id = "workflow-demo-caption"
      bar.style.cssText = "position:fixed;bottom:14px;left:50%;transform:translateX(-50%);z-index:99999;background:#1d4b40;color:#e7fff6;border:1px solid #5fa88f;border-radius:12px;padding:12px 22px;font:500 15px/1.4 system-ui;pointer-events:none;max-width:80vw;box-shadow:0 8px 24px #0006"
      document.body.append(bar)
    }
    bar.textContent = label
  }, text)
  await page.waitForTimeout(2200)
}
async function command(text) {
  const input = page.locator(".xterm-helper-textarea")
  await expect(input).toHaveCount(1)
  await input.focus(); await input.pressSequentially(text, { delay: 30 }); await input.press("Enter")
}
async function selectTerminal() {
  await page.locator(".session-row", { hasText: "01 · Terminal" }).click()
  if (!(await page.locator(".surface-tabs").isVisible())) await page.locator(".panel-toggle").click()
  const tab = page.locator(".surface-tab[title='Terminal']")
  if (await tab.count()) await tab.click()
  await expect(page.locator(".xterm-helper-textarea")).toHaveCount(1)
}
async function agent(provider, title, prompt) {
  const session = await page.evaluate(async ({ provider, title, cwd }) => window.chatHub.createSession({ provider, title, cwd, project: "Demo project" }), { provider, title, cwd: workDir })
  await page.locator(".session-row", { hasText: title }).click()
  const input = page.locator(".composer-shell textarea")
  await input.pressSequentially(prompt, { delay: 12 }); await input.press("Enter")
  await expect.poll(async () => {
    const allow = page.locator(".permission-banner").getByRole("button", { name: "Allow", exact: true })
    if (await allow.count()) { await page.waitForTimeout(1600); await allow.first().click() }
    return await page.evaluate(async id => (await window.chatHub.getSnapshot([id])).sessions.find(s => s.id === id)?.status, session.id)
  }, { timeout: 120_000, intervals: [500] }).toBe("done")
  await expect(page.locator(".turn.turn-assistant").last()).not.toHaveText("")
  await showChanges(page)
  await page.screenshot({ path: join(output, `${provider}.png`) })
}
try {
  await stage("1 / 5 · Реальный терминал: запускаем тесты небольшого проекта")
  await selectTerminal()
  await command("echo $$ > before.pid; export DEMO_SESSION=preserved; node --test")
  await expect(page.locator(".xterm-rows")).toContainText("fail 1")
  await stage("2 / 5 · Переходим в Files и обратно — процесс терминала сохраняется")
  await page.locator(".surface-tab[title='Files']").click()
  await page.waitForTimeout(2200)
  await selectTerminal()
  await command("echo $$ > after.pid; printf 'Session: %s\\n' \"$DEMO_SESSION\"")
  await expect(page.locator(".xterm-rows")).toContainText("Session: preserved")
  if (await readFile(join(workDir, "before.pid"), "utf8") !== await readFile(join(workDir, "after.pid"), "utf8")) throw new Error("PTY changed")
  if (live) {
    await stage("3 / 5 · Codex исправляет sum.mjs и запускает тесты")
    await agent("codex", "02 · Codex — fix", "В этом проекте падает node --test. Исправь только ошибку в sum.mjs, затем реально выполни node --test. Не меняй тесты. Не используй внешние сервисы. Коротко объясни результат по-русски.")
    execFileSync("node", ["--test"], { cwd: workDir, stdio: "pipe" })
    await stage("4 / 5 · Claude Code проверяет diff и повторно запускает тесты")
    await agent("claude", "03 · Claude — review", "Проверь git diff и sum.mjs, реально выполни node --test. Не меняй файлы, не используй внешние сервисы. Кратко сообщи по-русски, корректно ли исправление и есть ли замечания.")
  } else {
    await stage("3 / 5 · Offline demo: исправление fixture без вызова моделей")
    await writeFile(join(workDir, "sum.mjs"), "export const sum = (a, b) => a + b\n")
  }
  await stage("5 / 5 · Возвращаемся в тот же терминал: тесты теперь зелёные")
  await selectTerminal(); await command("node --test")
  await expect(page.locator(".xterm-rows")).toContainText("fail 0")
  await page.waitForTimeout(2200)
  await page.evaluate(() => document.getElementById("workflow-demo-caption")?.remove())
  await page.screenshot({ path: join(output, "workspace.png") })
  if (live) {
    await page.locator(".session-row", { hasText: "03 · Claude — review" }).click()
    await showChanges(page)
    await page.screenshot({ path: join(output, "overview.png") })
  }
  await app.context().tracing.stop({ path: join(output, "workflow-trace.zip") })
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, live, workDir, userData, source: executablePath ?? "local build" }, null, 2))
  console.log(`PASS. Screenshots and replay trace: ${output}`)
  if (once) await app.close()
  else { console.log("App remains open. Replay with pnpm demo:workflow --live. Close this demo window to exit."); await new Promise(resolve => app.on("close", resolve)) }
} catch (error) {
  console.error(error)
  await page.screenshot({ path: join(output, "failure.png") }).catch(() => {})
  await app.context().tracing.stop({ path: join(output, "failure-trace.zip") }).catch(() => {})
  await app.close(); process.exitCode = 1
}
