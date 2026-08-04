# Задача для Grok — реальный `waiting_input` + архив транскрипта

Ты в отдельном git worktree, ветка `feature/waiting-input-and-archive`, от `main` на
коммите `22bcb6d`. Другие сессии сейчас заняты git-worktree-per-session/PR-flow — это не
пересекается с задачей ниже, но перед финальным ребейзом на `main` проверь `git log main`
на новые коммиты.

## Что такое Chat Hub

Electron + React + TypeScript. Спавнит CLI `claude`/`grok`/`opencode`/`codex`, рендерит их
NDJSON-стрим. Перед началом:

```bash
cd chat-hub
pnpm install
pnpm test     # должно быть зелено
pnpm typecheck
```

---

## Задача A — реальный `waiting_input`

Сейчас в `src/shared/types.ts` есть статус сессии `"waiting_input"`, но его выставляет
**только** демо-сид (`src/main/demo-seed.ts:66`) и мок-адаптер. Ни один реальный CLI-адаптер
никогда его не ставит, поэтому фильтр «Wait» в сайдбаре (`Sidebar.tsx:87`) для реальных
сессий мёртв.

Но точка опоры уже есть: `src/main/permission-broker.ts` — класс `PermissionBroker`, поле
`pendingInputs: Map<string, PendingInput>` (строка 54). Это Ask-mode запросы ввода от агента
(`AgentInputRequestInfo`, события `input.request`/`input.resolved` в `HubEvent`,
`src/shared/types.ts`). Когда у сессии есть незакрытый `pendingInput` — это и есть момент,
когда сессия реально «ждёт ответа».

### Что сделать

1. В `src/main/session-manager.ts` — там, где сессия узнаёт о новом `input.request`
   (через подписку на события `PermissionBroker` или там, где уже обрабатывается
   `permission.request`/`permission.resolved` — найди этот паттерн и сделай по аналогии),
   выставляй `SessionMeta.status = "waiting_input"` пока у сессии есть хотя бы один
   pending input, и возвращай обратно в `"running"` (если turn ещё идёт) или `"idle"`
   (если turn уже завершился) когда все pending input для сессии закрыты.
2. Не трогай существующую механику для `permission.request` (allow/deny инструмента) — это
   отдельный, уже работающий поток. Только `pendingInputs` (Ask-mode текстовый ввод).
3. Публикуй `session.upsert` (или как уже принято обновлять статус в этом файле — смотри
   соседние места) при каждой смене статуса, чтобы сайдбар/`Sidebar.tsx` обновился живьём.

### Тесты

- В `tests/session-manager.test.ts` (или `tests/permission-broker.test.ts`, смотри где
  ближе по духу к существующим тестам) — минимум:
  - открытие pending input переводит сессию в `waiting_input`
  - закрытие последнего pending input возвращает `running`, если turn ещё идёт
  - закрытие последнего pending input возвращает `idle`, если turn уже завершился
  - несколько pending input на одну сессию — статус остаётся `waiting_input` пока не
    закрыты все

---

## Задача B — архив транскрипта, снять хардкап 200 сообщений

`src/main/session-manager.ts:32` — `const MAX_MESSAGES_PER_SESSION = 200`, применяется в
`appendMessage()` (строка 973): `while (list.length > MAX_MESSAGES_PER_SESSION) list.shift()`
— старые сообщения молча теряются на длинных сессиях, без архива, без ленивой подгрузки.

### Что сделать

1. Вместо `list.shift()` (тихого удаления) — при переполнении **выгружай** самые старые
   сообщения в отдельный файл на диске, например `<userData>/data/sessions/<id>/archive.jsonl`
   (append-only, дописывать хвостом). Посмотри как уже устроено хранение сессий в этом же
   файле/`src/main/settings.ts` или соседних (`state.json`?) — используй тот же паттерн
   путей/сериализации, не изобретай новый формат на пустом месте.
2. IPC-канал (по аналогии с остальными, `src/shared/ipc.ts` + `preload/index.ts`) —
   `loadArchivedMessages(sessionId, beforeMessageId, limit)`, читает архивный файл с конца,
   отдаёт порцию сообщений старше данного `messageId`.
3. UI: в транскрипте (`ChatView.tsx` или где рендерится список сообщений) — при скролле
   вверх до начала загруженного списка, если `hasArchive` (сессия когда-либо переполнялась),
   подгружай следующую порцию из архива и вставляй сверху, сохраняя позицию скролла.
4. Не меняй поведение для сессий короче 200 сообщений — там всё как было, архива нет,
   ничего не подгружается.

### Тесты

- `tests/session-manager.test.ts` (или новый файл): переполнение при 201-м сообщении
  выгружает самое старое в архив, а не удаляет безвозвратно; повторное переполнение
  дописывает архив, а не перезаписывает; `loadArchivedMessages` читает то, что было
  выгружено, в правильном порядке.

### Что НЕ делать

- Не переписывай общий формат `ChatMessage` — только где и как он хранится при
  переполнении.
- Не трогай `MAX_MESSAGES_PER_SESSION` — оставь порог 200, просто перестань терять данные
  после него.

---

## Приёмка

```bash
pnpm test
pnpm typecheck
pnpm build
```

Коммить в `feature/waiting-input-and-archive` маленькими коммитами по теме (A отдельно от
B), тон сообщений — как в `git log --oneline -20`. В `main` не мёрджить, ветку не удалять.
