import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron } from "@playwright/test"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const PAUSE = 1600

const act = async (page, label, ms = PAUSE) => {
  console.log(`\n▶ ${label}`)
  await page.waitForTimeout(ms)
}

const userData = await mkdtemp(join(tmpdir(), "chat-hub-demo-"))
const workDir = await mkdtemp(join(tmpdir(), "chat-hub-demo-work-"))
const dataDir = join(userData, "data")
await mkdir(dataDir, { recursive: true })
const now = Date.now()
const sessions = [
  { id: "s1", title: "Fix webhook retries" },
  { id: "s2", title: "Tune reward curve" },
  { id: "s3", title: "Ship the boot skeleton" },
].map((s, i) => ({
  ...s,
  project: "demo",
  provider: "mock",
  cwd: workDir,
  status: "idle",
  createdAt: now - (3 - i) * 60_000,
  updatedAt: now - (3 - i) * 30_000,
}))
await writeFile(
  join(dataDir, "index.json"),
  JSON.stringify({ version: 1, sessions, usage: {}, activeSessionId: "s1" }),
)
for (const s of sessions) {
  await mkdir(join(dataDir, "sessions", s.id), { recursive: true })
  await writeFile(join(dataDir, "sessions", s.id, "hot.json"), "[]")
}

console.log("Запускаю Chat Hub с тремя демо-сессиями…")
const app = await _electron.launch({
  args: [join(ROOT, "out", "main", "index.js")],
  cwd: ROOT,
  env: { ...process.env, CHAT_HUB_USER_DATA: userData },
})
const page = await app.firstWindow()
await page.locator(".session-row").first().waitFor()

await act(page, "АКТ 1 · Бут: окно, сайдбар, три сессии на месте")

await act(page, "АКТ 2 · Открываю чат и пишу агенту")
await page.locator(".session-row", { hasText: "Fix webhook retries" }).click()
const composer = page.locator("textarea").first()
await composer.click()
await composer.pressSequentially(
  "Проверь ретраи вебхуков и предложи фикс",
  { delay: 55 },
)
await page.waitForTimeout(700)
await composer.press("Enter")

await act(page, "АКТ 3 · Mock-агент стримит ответ (смотри на орб статуса)", 400)
await page.locator(".turn.turn-assistant").first().waitFor({ timeout: 20_000 })
await page.waitForTimeout(3500)

await act(page, "АКТ 4 · Палитра ⌘K: fuzzy-прыжок к сессии")
await page.keyboard.press("Meta+k")
await page.waitForTimeout(900)
const palette = page.getByPlaceholder(/Jump to session/)
await palette.pressSequentially("reward", { delay: 120 })
await page.waitForTimeout(1100)
await palette.press("Enter")

await act(page, "АКТ 5 · Ctrl+Tab: свитчер недавних сессий")
await page.keyboard.down("Control")
await page.keyboard.press("Tab")
await page.waitForTimeout(1400)
await page.keyboard.press("Tab")
await page.waitForTimeout(1400)
await page.keyboard.up("Control")

await act(page, "АКТ 6 · Инбокс агентов ⌥⇧I")
await page.keyboard.press("Alt+Shift+KeyI")
await page.waitForTimeout(2200)
await page.keyboard.press("Escape")

await act(page, "АКТ 7 · Второе окно через палитру")
await page.keyboard.press("Meta+k")
await page.waitForTimeout(700)
await page
  .getByPlaceholder(/Jump to session/)
  .pressSequentially("new window", { delay: 90 })
const win2 = app.waitForEvent("window")
await page.getByPlaceholder(/Jump to session/).press("Enter")
const second = await win2
await second.waitForLoadState("domcontentloaded")
await page.waitForTimeout(2500)

await act(page, "АКТ 8 · Мгновенный архив и Undo")
const row = page.locator(".session-row", { hasText: "Ship the boot skeleton" })
await row.hover()
await page.waitForTimeout(900)
await row.locator('[title^="Archive session"]').click()
await page.waitForTimeout(1800)
await page.locator(".toast-action").click()
await page.waitForTimeout(1500)

await act(page, "ФИНАЛ · Всё работает. Закрываю через 5 секунд", 5000)
await app.close()
console.log("\n✔ Демо-тур завершён без ошибок")
