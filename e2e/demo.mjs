import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron } from "@playwright/test"
import { sessionMetas, writeSeedData } from "./seed.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const HOLD = 3200
const TYPE_DELAY = 95

async function banner(page, text) {
  console.log(`\n▶ ${text}`)
  await page.evaluate((label) => {
    let el = document.getElementById("demo-banner")
    if (!el) {
      el = document.createElement("div")
      el.id = "demo-banner"
      el.style.cssText = [
        "position:fixed", "top:14px", "left:50%",
        "transform:translateX(-50%)", "z-index:99999",
        "background:#0d9488", "color:#fff",
        "font:600 17px/1.4 -apple-system,sans-serif",
        "padding:12px 26px", "border-radius:99px",
        "box-shadow:0 8px 30px rgba(0,0,0,.45)",
        "pointer-events:none", "transition:opacity .3s",
        "max-width:80vw", "text-align:center",
      ].join(";")
      document.body.appendChild(el)
    }
    el.textContent = label
    el.style.opacity = "1"
  }, text)
}

async function spotlight(page, locator) {
  await locator.evaluate((el) => {
    el.style.outline = "3px solid #f5b453"
    el.style.outlineOffset = "2px"
    setTimeout(() => {
      el.style.outline = ""
      el.style.outlineOffset = ""
    }, 1800)
  })
  await page.waitForTimeout(1400)
}

const userData = await mkdtemp(join(tmpdir(), "chat-hub-demo-"))
const workDir = await mkdtemp(join(tmpdir(), "chat-hub-demo-work-"))
const now = Date.now()
const metas = sessionMetas(
  [
    { id: "s1", title: "Fix webhook retries", project: "demo" },
    { id: "s2", title: "Tune reward curve", project: "demo" },
    { id: "s3", title: "Ship the boot skeleton", project: "demo" },
  ],
  workDir,
  now,
)
await writeSeedData(userData, metas, workDir, now)

console.log("Запускаю Chat Hub (демо-профиль, твои данные не трогаю)…")
const app = await _electron.launch({
  args: [join(ROOT, "out", "main", "index.js")],
  cwd: ROOT,
  env: { ...process.env, CHAT_HUB_USER_DATA: userData },
})
const page = await app.firstWindow()
await page.locator(".session-row").first().waitFor()
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.setBounds({ x: 80, y: 60, width: 1440, height: 900 })
  win.show()
  win.focus()
})
await page.waitForTimeout(1200)

await banner(page, "Шаг 1 / 8 · Бут: сайдбар и три сессии загрузились из index.json")
await spotlight(page, page.locator(".session-row").first())
await page.waitForTimeout(HOLD)

await banner(page, "Шаг 2 / 8 · Открываю сессию и печатаю сообщение агенту")
const firstRow = page.locator(".session-row", { hasText: "Fix webhook retries" })
await spotlight(page, firstRow)
await firstRow.click()
const composer = page.locator("textarea").first()
await composer.click()
await composer.pressSequentially(
  "Проверь ретраи вебхуков и предложи фикс",
  { delay: TYPE_DELAY },
)
await page.waitForTimeout(1500)
await composer.press("Enter")

await banner(page, "Шаг 3 / 8 · Агент стримит ответ — смотри на орб и текст")
await page.locator(".turn.turn-assistant").first().waitFor({ timeout: 20_000 })
await page.waitForTimeout(5000)

await banner(page, "Шаг 4 / 8 · Палитра ⌘K: печатаю «reward» и прыгаю в сессию")
await page.keyboard.press("Meta+k")
await page.waitForTimeout(1400)
const palette = page.getByPlaceholder(/Jump to session/)
await palette.pressSequentially("reward", { delay: 150 })
await page.waitForTimeout(1800)
await palette.press("Enter")
await spotlight(page, page.locator(".session-row.active"))
await page.waitForTimeout(HOLD)

await banner(page, "Шаг 5 / 8 · Держу Ctrl, листаю Tab — свитчер недавних сессий")
await page.keyboard.down("Control")
await page.keyboard.press("Tab")
await page.waitForTimeout(2000)
await page.keyboard.press("Tab")
await page.waitForTimeout(2000)
await page.keyboard.up("Control")
await page.waitForTimeout(HOLD)

await banner(page, "Шаг 6 / 8 · Инбокс агентов ⌥⇧I — сейчас пусто: All clear")
await page.keyboard.press("Alt+Shift+KeyI")
await page.waitForTimeout(3200)
await page.keyboard.press("Escape")
await page.waitForTimeout(1200)

await banner(page, "Шаг 7 / 8 · Команда New Window — второе окно тех же сессий")
await page.keyboard.press("Meta+k")
await page.waitForTimeout(1000)
await page
  .getByPlaceholder(/Jump to session/)
  .pressSequentially("new window", { delay: 120 })
await page.waitForTimeout(1200)
const win2 = app.waitForEvent("window")
await page.getByPlaceholder(/Jump to session/).press("Enter")
const second = await win2
await second.waitForLoadState("domcontentloaded")
await page.waitForTimeout(3500)
await second.close()
await page.waitForTimeout(1200)
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.focus()
})

await banner(page, "Шаг 8 / 8 · Архивирую сессию — и возвращаю её через Undo")
const row = page.locator(".session-row", { hasText: "Ship the boot skeleton" })
await row.hover()
await spotlight(page, row)
await row.locator('[title^="Archive session"]').click()
await page.waitForTimeout(2600)
const undo = page.locator(".toast-action")
await spotlight(page, undo)
await undo.click()
await spotlight(page, page.locator(".session-row", { hasText: "Ship the boot skeleton" }))
await page.waitForTimeout(HOLD)

await banner(page, "Шаг 9 · АГЕНТ ЗА РАБОТОЙ: план, todo-галочки, тулы, пермишены")
await page.locator(".session-row", { hasText: "Tune reward curve" }).click()
const composer2 = page.locator("textarea").first()
await composer2.click()
await composer2.pressSequentially("showcase: почини ретраи вебхуков", {
  delay: TYPE_DELAY,
})
await page.waitForTimeout(1000)
await composer2.press("Enter")

await banner(page, "Шаг 9 · Появился план из 4 задач — смотри, как агент их закрывает")
await page.locator(".turn.turn-assistant").last().waitFor({ timeout: 20_000 })
await page.waitForTimeout(6000)

await banner(page, "Шаг 10 · Агент просит разрешение на pnpm test — отвечаю из инбокса")
await page.locator(".permission-banner").waitFor({ timeout: 30_000 })
await spotlight(page, page.locator(".permission-banner"))
await page.waitForTimeout(1200)
await page.keyboard.press("Alt+Shift+KeyI")
await page.waitForTimeout(2400)
const allowBtn = page.getByRole("button", { name: "Allow", exact: true }).first()
await spotlight(page, allowBtn)
await allowBtn.click()
await page.waitForTimeout(1500)
await page.keyboard.press("Escape")

await banner(page, "Шаг 11 · Тесты бегут, план закрывается, внизу — цена хода")
await page
  .locator(".turn.turn-assistant", { hasText: "42 passed" })
  .waitFor({ timeout: 30_000 })
await page.waitForTimeout(2500)
const costMeta = page.locator(".turn-cost").last()
if (await costMeta.count()) await spotlight(page, costMeta)
await page.waitForTimeout(HOLD)

await banner(page, "Готово: 11 из 11 сценариев прошли. Закрываюсь через 6 секунд")
await page.waitForTimeout(6000)
await app.close()
console.log("\n✔ Демо-тур завершён без ошибок")
