# Задача для Grok — MCP-менеджер для Chat Hub

Ты работаешь в отдельном git worktree, ветка `feature/mcp-manager`, ответвлена от
`main` на коммите `ac264fc`. Это **не** тот же чекаут, где работает другая Claude-сессия —
у неё сейчас в работе worktree-per-session, разведение `touchedFiles`, History-панель и
связанный git-флоу. **Не трогай эти темы** — только MCP, иначе будет конфликт при мёрже.

Параллельно в worktree `chat-hub-panes-features` (ветка `feature/panes-hooks-audit`) уже
сделаны хуки (`.chathub/hooks`) и pre-commit audit-trail. **Не дублируй и не ребейзь
поверх той ветки** — у тебя свой base (`ac264fc`). Хуков в твоём дереве ещё нет — это
нормально, они приедут отдельным мёржем.

## Что такое Chat Hub

Electron + React + TypeScript. Спавнит CLI `claude` / `grok` / `opencode` / `codex` как
child process, один turn на сессию, рендерит их стрим. Структура:

```
src/main/            — Electron main process: session-manager.ts (жизненный цикл сессии),
                        adapters/ (по одному на CLI), git.ts, settings.ts, secret.ts
src/renderer/src/     — React UI. App.tsx — весь стейт, без стора/роутера.
                        components/SettingsModal.tsx — табы General / Providers /
                        Connections / Advanced (сюда и вешать MCP UI)
                        components/surfaces/ — правые панели: Browser, Terminal, Files,
                        Diff, Board (SurfaceDock.tsx их переключает)
src/shared/           — общие типы: types.ts, settings-types.ts, surfaces.ts, ipc.ts
tests/                — vitest, 31 файл / 320 тестов на момент ветвления
```

Перед началом:

```bash
cd chat-hub    # это уже твой worktree (корень worktree и есть chat-hub)
pnpm install
pnpm test      # должно быть зелено — 320/320 (+ 2 skipped)
pnpm typecheck
```

`pnpm dev` виснет без TTY — если запускаешь не из интерактивного терминала, оборачивай в
`script -q /dev/null ./node_modules/.bin/electron-vite dev`. UI-превью без Electron:
`pnpm dev`, потом открыть `http://localhost:5173/?mock=1` в браузере.

## Что уже сделано (не переделывать)

- **In-app Allow/Deny** уже подключен: `App.tsx` → `onResolvePermission` → `ChatView`.
- **Секреты провайдеров** уже шифруются через `src/main/secret.ts` (`sealSecret` /
  `openSecret` + Electron `safeStorage`). Renderer видит только имена ключей
  (`envKeys`), не значения. **Тот же путь используй для секретов MCP** — не изобретай
  второй keystore.
- **Settings → Connections** уже есть, но там только Session Monitor bridge path.
  MCP UI логично положить **в этот же таб**, ниже bridge-блока (не новый top-level tab,
  если не упрёшься в плотность).
- **Codex adapter** уже *рендерит* MCP tool-call'ы в транскрипте
  (`src/main/adapters/codex.ts`, case `mcp_tool_call` / elicitation). Это runtime
  CLI, не конфиг. **Не переписывай** парсер стрима — тебе нужен только конфиг-менеджер,
  который CLIs сами читают.

---

## Зачем эта фича

В FEATURE-GAP (P2) MCP — «самая заметная дыра» относительно T3 Code и Kiro. Hub **не**
становится MCP-клиентом: он **управляет конфигом** и **прокидывает** его в файлы, которые
уже понимают `claude` / `codex` / `opencode`. Grok CLI MCP на момент задачи можно
игнорировать (если найдёшь официальный путь — добавь как no-op/TODO, не блокируй MVP).

Источник идей: Kiro/T3 MCP manager UI, native-файлы CLI:

| CLI | Куда писать (project-scope) | Форма |
|---|---|---|
| Claude Code | `<cwd>/.mcp.json` | `{ "mcpServers": { "<name>": { command, args, env? } } }` |
| Codex | `<cwd>/.codex/config.toml` | `[mcp_servers.<name>]` + `command` / `args` / optional `[mcp_servers.<name>.env]` |
| OpenCode | `<cwd>/opencode.json` (или merge) | `{ "mcp": { "<name>": { "type": "local"\|"remote", "command"?: [...], "url"?: "...", "enabled": true, "environment"?: {} } } }` |

Hub-канон (то, что редактирует UI и что коммитится в репо **без секретов**):

```
<cwd>/.chathub/mcp.json
```

---

## Задача A — модель, store, materialize, секреты

### A1. Канонический формат `.chathub/mcp.json`

```json
{
  "version": 1,
  "servers": [
    {
      "id": "github",
      "name": "github",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "envKeys": ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      "url": null
    },
    {
      "id": "remote-docs",
      "name": "remote-docs",
      "enabled": false,
      "transport": "http",
      "command": null,
      "args": [],
      "envKeys": [],
      "url": "https://example.com/mcp"
    }
  ]
}
```

Правила:
- `id` — стабильный slug (`[a-z0-9][a-z0-9_-]*`), уникален в файле.
- `name` — display / ключ в native-конфигах CLI (обычно = id).
- `transport`: `"stdio"` | `"http"` (union заложи на оба; MVP-UI может фокусироваться на stdio).
- `stdio` требует `command` (непустая строка); `args` — массив строк (может быть `[]`).
- `http` требует `url` (http/https).
- **Никаких secret values в этом файле** — только `envKeys: string[]` (имена переменных).
- `enabled: false` — сервер остаётся в каноне, но **не** попадает в materialize (или
  попадает с `enabled: false` там, где native-формат это поддерживает — OpenCode).

Типы: новый `src/shared/mcp.ts` (или блок в `settings-types.ts` — смотри, как разложены
board/surfaces; MCP ближе к project-file, как board, чем к user settings — отдельный
`mcp.ts` предпочтительнее).

Минимум типов:
- `McpTransport`, `McpServerDef`, `McpProjectConfig` (`version` + `servers`)
- `McpServerStatus`: `{ id, name, enabled, transport, state: "unknown"|"ok"|"error"|"disabled", detail?: string, checkedAt?: number }`
- `McpSecretPatch`: `{ serverId, env: Record<string, string> }` — пустое значение = удалить ключ
  (как у `setProviderConfig` env).

### A2. Main-process store: `src/main/mcp.ts` (новый)

По образцу `src/main/surfaces/board.ts` (read/coerce/write atomic):

1. `readMcpConfig(cwd): Promise<McpProjectConfig>` — missing file → `{ version: 1, servers: [] }`.
2. `writeMcpConfig(cwd, config): Promise<McpProjectConfig>` — валидация, atomic write в
   `.chathub/mcp.json` (используй `writeFileAtomic` из `atomic-write.ts` / тот же приём, что board).
3. `parseMcpConfig(raw): McpProjectConfig | null` — жёсткая валидация; мусор → null / coerce
   с отбрасыванием битых серверов (как board coerce). Задокументируй выбор в комментарии.
4. `listMcpServers(cwd)` / `upsertMcpServer(cwd, def)` / `removeMcpServer(cwd, id)` /
   `setMcpServerEnabled(cwd, id, enabled)` — thin CRUD поверх read/write.

Секреты (**user-level**, не в project file):
- Храни в `HubSettings` новое поле, например `mcpEnv: Record<string, Record<string, string>>`
  где outer key = `serverId`, inner = env var name → **sealed** value через `sealSecret`.
- Bump `HubSettings.version` если это ломает loaders (сейчас `version: 2`) — либо оставь
  version и просто добавь optional field с default `{}` на load (предпочтительно, меньше
  миграций).
- Renderer **никогда** не получает plaintext: в snapshot/list отдавай только
  `envKeysPresent: string[]` (имена, у которых sealed value есть).
- API: `setMcpServerEnv(serverId, envPatch)` по образцу `SettingsStore.setProviderConfig`
  env-merge (empty string deletes).

### A3. Materialize — запись native-конфигов CLI

Функция `materializeMcpForProject(cwd, options?)`:

1. Читает `.chathub/mcp.json`.
2. Подставляет decrypted env из settings **только в память** для записи native-файлов.
3. Пишет/обновляет:
   - **Claude**: `<cwd>/.mcp.json` — полный объект `mcpServers` из *enabled* stdio-серверов.
     Если файла не было — создать. Если был — **merge по ключу name**, не затирая
     серверы, которых нет в Hub-каноне (помечай hub-managed: либо перезаписывай только
     ключи, чьи `id`/`name` есть в каноне; чужие ключи оставь).
   - **Codex**: `<cwd>/.codex/config.toml` — аккуратно merge секций `[mcp_servers.<name>]`.
     Не парси TOML «на коленке» хрупким regex, если можно: либо минимальный structured
     writer, который (a) читает существующий файл как текст, (b) заменяет/добавляет
     **только** блоки `mcp_servers.<name>`, которые Hub знает, (c) не трогает остальное.
     Если честный TOML-merge слишком тяжёлый для MVP — **ограничься записью отдельного
     фрагмента** `.codex/chathub-mcp.toml` + документируй, что пользователь должен
     `include`/скопировать, **или** пиши полный managed-блок между маркерами:

     ```
     # BEGIN CHATHUB-MCP
     ...
     # END CHATHUB-MCP
     ```

     Маркерный блок — предпочтительный MVP: идемпотентный, без зависимости toml-парсера.
   - **OpenCode**: merge в `<cwd>/opencode.json` ключ `mcp` (JSON — проще). Не ломай
     остальные ключи файла. Missing file → `{ "mcp": { ... } }` только если нужно;
     если файла нет и серверов нет — **не** создавай пустой opencode.json.

4. `materialize` вызывается:
   - после любого успешного CRUD/secret save из IPC;
   - опционально при `createSession` для session.cwd (fire-and-forget, не блокируя create).

**Важно:** materialize пишет secret values в native CLI-файлы (иначе CLI их не увидит).
Это deliberate trade-off. В `.chathub/mcp.json` секретов нет. В UI предупреди одной
строкой: «Secrets are written into local CLI config files on disk; keep those files out
of git if they contain tokens» (gitignore-подсказка: `.mcp.json` env / `.codex/` часто
уже в ignore у людей, но не навязывай авто-gitignore без явной кнопки).

### A4. Status probe (лёгкий)

Не поднимай полный MCP SDK. MVP статуса:
- `disabled` → state `disabled`
- `stdio`: проверить, что `command` резолвится (`which` / `fs.access` на absolute path);
  optional: `spawn(command, [...args, "--help"])` с коротким timeout — **не** обязателен,
  достаточно «command found / not found».
- `http`: опционально `HEAD`/`GET` с timeout 2s; fail → `error` с detail, success → `ok`.
  Если сетевой probe ненадёжен — оставь `unknown` + detail «not probed».
- Результат **не** обязательно персистить; можно считать on-demand через IPC
  `mcp:status(cwd)`.

### A5. IPC + preload

В `src/shared/ipc.ts` добавь каналы (конвенция `mcp:*`):

```
mcpList            — (cwd) → { config, statuses, envKeysByServer }
mcpUpsert          — (cwd, serverDef) → same
mcpRemove          — (cwd, id) → same
mcpSetEnabled      — (cwd, id, enabled) → same
mcpSetEnv          — (serverId, envPatch) → envKeys for that server
mcpMaterialize     — (cwd) → { ok, written: string[] }  // paths touched
mcpStatus          — (cwd) → statuses[]
```

Пробрось в `src/preload/index.ts` + `ChatHubApi` types. Handlers — в
`src/main/index.ts` или `src/main/surfaces/index.ts` (как board). Валидируй `cwd` через
тот же `resolveWorkspaceRoot`, что board/files.

### A6. Тесты — `tests/mcp.test.ts` (новый)

Минимум:
1. `parseMcpConfig` — валидный / битый JSON / неизвестный transport / missing command на stdio.
2. CRUD round-trip на tmp dir: upsert → read → remove.
3. `enabled: false` не попадает в Claude materialize output (или попадает disabled — зафиксируй
   контракт тестом).
4. Materialize Claude: из канона получается корректный `.mcp.json`; повторный вызов
   идемпотентен; чужой pre-existing server в `.mcp.json` **не** стирается.
5. Materialize OpenCode: merge не затирает соседние ключи `opencode.json`.
6. Codex marker-block: повторный materialize не дублирует BEGIN/END блок.
7. Secrets: `sealSecret` path — после `setMcpServerEnv` plaintext **нет** в
   `.chathub/mcp.json` и **нет** в `settings.json` raw (только `enc:v1:` / `plain:v1:`
   prefix); materialize **кладёт** plaintext в native file (проверь tmp).
8. `envKeys` empty-string patch удаляет ключ.

Mock `electron.safeStorage` так же, как `tests/settings.test.ts` / `session-manager.test.ts`.

---

## Задача B — UI в Settings → Connections

### B1. Список и CRUD

В `SettingsModal.tsx`, таб `connections`, **ниже** существующего Session Monitor блока:

- Заголовок секции **MCP servers**.
- Нужен **cwd проекта**: возьми `activeSession.cwd` из App (пробрось prop
  `projectCwd: string | null` в `SettingsModal`) **или** первый pinned project —
  предпочтительно active session cwd, fallback «Open a session / pick a project to
  manage MCP». Без cwd — disabled empty state, не падай.
- Список карточек серверов: name, transport badge, enabled toggle, status pill
  (`ok` / `error` / `disabled` / `unknown`), command/url one-liner.
- Кнопки: **Add server**, **Edit**, **Remove**, **Apply to CLIs** (`mcpMaterialize`),
  **Refresh status**.
- Форма Add/Edit (inline или маленький sub-modal — как проще в существующем CSS):
  - name/id (id авто из name slug, editable до первого save)
  - transport select
  - command + args (args — comma/space-separated input → `string[]`, задокументируй)
  - url (если http)
  - env key fields: reuse pattern `EnvField` уже в SettingsModal (write-only password
    inputs). При save зови `mcpSetEnv`.

### B2. Лог / detail

Под списком или в expand карточки — `detail` из status (например «command not found:
uvx»). Не нужен streaming log runtime MCP; достаточно last probe detail.

### B3. dev-mock

Если `?mock=1` — добавь stub'ы `mcp*` в `src/renderer/src/dev-mock.ts`, чтобы Settings
не падал в браузерном превью.

### B4. Тесты UI-логики (без Electron)

- Чистые функции slugify / args-parse / merge helpers — unit tests.
- Если вынесешь presentational helpers — покрой; полный React mount не обязателен
  (в репо нет RTL), достаточно main-process + pure helpers.

### Что НЕ делать

- Не пиши свой MCP host/client (stdio JSON-RPC loop) внутри Hub.
- Не трогай `src/main/git.ts`, worktree-per-session, History, `touchedFiles`, Board merge.
- Не добавляй cloud/remote MCP marketplace.
- Не коммить реальные токены; в фикстурах — dummy values.
- Не мёрджи в `main`.
- Grok provider MCP — out of scope, если нет явного public config path.

---

## Приёмка

```bash
pnpm test        # всё зелёное, включая tests/mcp.test.ts
pnpm typecheck
pnpm build        # electron-vite build проходит
```

Ручная sanity (если есть TTY):
1. Открыть Settings → Connections, добавить stdio server `echo` / `npx -y @modelcontextprotocol/server-memory` (или простой `command: "true"`).
2. Apply to CLIs → появились/обновились `.chathub/mcp.json` и native files.
3. Выключить enabled → materialize убирает/дизейблит в native.
4. Секрет: задать env key → в `.chathub/mcp.json` только имя ключа; в settings.json sealed.

Коммить в `feature/mcp-manager` маленькими коммитами по теме, тон как в
`git log --oneline -20` (коротко, по делу, без «AI-шва»). Пример разбиения:

1. `feat: project MCP config types and store`
2. `feat: materialize MCP config into Claude/Codex/OpenCode files`
3. `feat: MCP manager UI in Settings → Connections`
4. `test: cover MCP parse, secrets and materialize`

Когда закончишь — **не мёрджи в `main`**, оставь ветку готовой к ревью.
