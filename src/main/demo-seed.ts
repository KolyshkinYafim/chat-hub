import { randomUUID } from "node:crypto"
import type { ChatMessage, SessionMeta } from "@shared/types"

const hour = 3600_000
const now = () => Date.now()

function session(partial: {
  title: string
  project: string
  provider: SessionMeta["provider"]
  cwd: string
  hoursAgo: number
  status?: SessionMeta["status"]
}): SessionMeta {
  const t = now() - partial.hoursAgo * hour
  return {
    id: randomUUID(),
    title: partial.title,
    project: partial.project,
    provider: partial.provider,
    cwd: partial.cwd,
    status: partial.status ?? "idle",
    createdAt: t - hour,
    updatedAt: t,
  }
}

function msg(
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
  minutesAgo: number,
): ChatMessage {
  return {
    id: randomUUID(),
    sessionId,
    role,
    content,
    createdAt: now() - minutesAgo * 60_000,
  }
}

/** First-run demo so the shell looks like a multi-project agent workbench. */
export function buildDemoState(): {
  sessions: SessionMeta[]
  messages: Record<string, ChatMessage[]>
  activeSessionId: string
} {
  const handoff = session({
    title: "Handoff по фронтенд-рефакторингу",
    project: "mary",
    provider: "mock",
    cwd: "/Users/dev/projects/mary",
    hoursAgo: 0.1,
    status: "done",
  })
  const working = session({
    title: "Ответ о reasoni…",
    project: "mary",
    provider: "mock",
    cwd: "/Users/dev/projects/mary",
    hoursAgo: 3,
    status: "running",
  })
  // Never seed sticky running without a process — use waiting_input for live feel.
  working.status = "waiting_input"

  const crm = session({
    title: "Проверка CRM PicPac на …",
    project: "mary",
    provider: "mock",
    cwd: "/Users/dev/projects/mary",
    hoursAgo: 5,
  })
  const inspect = session({
    title: "Inspect folder contents",
    project: "mary",
    provider: "mock",
    cwd: "/Users/dev/projects/mary",
    hoursAgo: 48,
  })

  const master10 = session({
    title: "Master-промпт для 10 ло…",
    project: "FinanceApp",
    provider: "mock",
    cwd: "/Users/dev/projects/FinanceApp",
    hoursAgo: 19,
  })
  const logo = session({
    title: "Master prompt for logo ge…",
    project: "FinanceApp",
    provider: "mock",
    cwd: "/Users/dev/projects/FinanceApp",
    hoursAgo: 19,
  })

  const t3 = session({
    title: "Оценка сторонней обвязки",
    project: "NSFW",
    provider: "mock",
    cwd: "/Users/dev/projects/NSFW",
    hoursAgo: 24,
  })

  const redux = session({
    title: "Redux crash on clients pa…",
    project: "ProxyFlash",
    provider: "mock",
    cwd: "/Users/dev/projects/ProxyFlash",
    hoursAgo: 24,
  })
  const blank = session({
    title: "Fix blank clients page error",
    project: "ProxyFlash",
    provider: "mock",
    cwd: "/Users/dev/projects/ProxyFlash",
    hoursAgo: 24,
  })

  const sessions = [
    handoff,
    working,
    crm,
    inspect,
    master10,
    logo,
    t3,
    redux,
    blank,
  ]

  const handoffBody = `## Инженерное решение по «идеальному FSD» (честно)

Я сознательно **не** стал гнать косметическую миграцию generic \`useResource\` → per-entity хуки по всем кластерам. Причина: dept-tree и подобные шарят кэш-ключи между страницами и завязаны на \`use-infra-refetch\` (+ его unit-тест). Частичная миграция рассинхронит кэш и сломает тесты, а функционально всё уже на RQ и корректно инвалидируется. Это был бы риск регрессий ради нулевого функционального выигрыша.

**Вывод:** generic RQ-backed \`useResource\` — это и есть чистый быстрый кэш-слой. Как эталон идиоматичного FSD добавил \`useDepartmentTree\` / \`useInvalidateDepartmentTree\` (доступны для новых экранов).

### Итоговое состояние фронта

- ✅ FSD: \`entities/*\` · \`features/*\` · \`shared/*\`, тонкий barrel (\`lib/api\` 3587→139)
- ✅ Модульные импорты (0 файлов app/components/lib на @/lib/api)
- ✅ Единый кэш-слой на React Query (мгновенная отрисовка из кэша = «быстро»)
- ✅ Проверено вживую на реальном API
- ✅ 134 изменения в git, **не пушено**

### Что осталось (по желанию, не блокеры)

Конверсия ~84 raw \`useEffect\`+fetch в RQ-хуки (делать волнами с этим же live-драйвером), пред-существующий hydration-warning на \`/login\`, и сборка ветки/коммита (без \`rq_functional_sweep.spec.ts\`). Скажешь — соберу коммит или продолжу волны.`

  const messages: Record<string, ChatMessage[]> = {
    [handoff.id]: [
      msg(
        handoff.id,
        "user",
        "Собери handoff: что сделано по FSD/RQ, что сознательно не трогали, и что осталось.",
        45,
      ),
      msg(handoff.id, "assistant", handoffBody, 40),
    ],
    [working.id]: [
      msg(
        working.id,
        "user",
        "Почему reasoning token stream иногда рвётся на длинных ответах?",
        180,
      ),
      msg(
        working.id,
        "assistant",
        "Смотрю логи провайдера и backpressure на stream chunk boundary…\n\nНужно твоё подтверждение: **ретраить** обрыв с offset, или **fail-fast** и показать partial?",
        175,
      ),
    ],
    [crm.id]: [
      msg(crm.id, "user", "Прогони smoke по CRM PicPac карточкам.", 300),
      msg(
        crm.id,
        "assistant",
        "### CRM smoke\n\n| Area | Result |\n|------|--------|\n| List | ok |\n| Detail | ok |\n| Edit save | flaky once, retry ok |\n\n```ts\nawait page.getByRole('button', { name: 'Save' }).click()\n```\n\nГотово к merge после зелёного CI.",
        290,
      ),
    ],
  }

  return {
    sessions,
    messages,
    activeSessionId: handoff.id,
  }
}
