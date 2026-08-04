# Chat Hub — multi-agent delivery plan

Дата: 2026-08-04  
Базовая ветка: `main`  
Базовый коммит на момент планирования: `ac264fc21071591a14db5e3b6d756c179cc4a5ee`

Этот документ — единый dispatch-пакет для разработки Chat Hub в отдельных git worktree.
Он задаёт границы задач, порядок интеграции, обязательные результаты от исполнителей и
release-gate перед установкой приложения как daily driver.

## 1. Зафиксированное состояние

- `main@ac264fc`: `320 passed`, `2 skipped`; `pnpm typecheck` проходит.
- `docs/FEATURE-GAP.md` изменён локально пользователем. Исполнители не должны включать этот
  файл в свои ветки или перетирать его.
- `codex/chathub-full-runtime` уже интегрирован в `main`; отдельная работа там не нужна.
- `feature/mcp-manager` содержит только готовый brief `TASKS-FOR-GROK.md`; реализация MCP ещё
  не начата.
- `feature/panes-hooks-audit` содержит три готовых коммита hooks/audit trail, но основана на
  старом `15727ae`; её надо сначала отдельно проверить и перенести на свежий `main`.
- Вложение через picker и paste работает. Реального drag-and-drop в renderer сейчас нет.
- Browser surface существует, но это базовый `<webview>` с фиксированным localhost:5173,
  без port detection, реальной history, screenshot, annotations и системного открытия.
- Developer menu и проектные Actions отсутствуют.
- Worktree/branch-per-session, push/PR и persisted archive отсутствуют.

## 2. Правила для всех исполнителей

Каждый агент работает только в выданном worktree и не делает merge в `main`.

Перед работой:

```bash
git status --short --branch
git rev-parse HEAD
pnpm install
pnpm test
pnpm typecheck
```

Во время работы:

- не менять `docs/FEATURE-GAP.md`;
- не трогать файлы вне ownership задачи без явного согласования;
- делать 1–3 атомарных коммита, без `WIP`;
- не коммитить токены, реальные пути к секретам, логи с prompt/content или build output;
- не выполнять реальный push/PR из тестов;
- не удалять dirty/unpushed worktree автоматически;
- UI-логику по возможности выносить из `App.tsx` и `styles.css` в отдельные компоненты/модули.

Финальные обязательные проверки в каждой ветке:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
git status --short
git diff --stat <BASE_SHA>...HEAD
```

## 3. Что отправить каждому агенту

В сообщение исполнителю нужно вставить:

1. абсолютный путь worktree;
2. имя ветки и `BASE_SHA`;
3. полный scope из соответствующего раздела ниже;
4. ownership и список запретов;
5. acceptance criteria;
6. команды проверки;
7. шаблон handoff из раздела 8.

Короткая вводная для любого агента:

> Ты работаешь над Chat Hub — Electron 35 + React 19 + TypeScript. Работай только в указанном
> worktree. Не мёрджи в main, не меняй FEATURE-GAP.md и не расширяй scope. Сначала подтверди
> baseline. Верни атомарные коммиты и полный HANDOFF по шаблону delivery plan.

## 4. Wave 0 — сначала принять уже существующую работу

### W0-A. Hooks и pre-commit audit trail

- Ветка: `feature/panes-hooks-audit`
- Worktree: `/Users/yafimkolyshkin/Desktop/agent-desktop-suite/agent-desktop-suite-worktrees/chat-hub-panes-features`
- Текущий HEAD: `3763c05`
- Задача: только review, rebase/cherry-pick rehearsal и валидация трёх существующих коммитов.
- Не добавлять новые hooks-фичи.
- Особо проверить пересечения: `session-manager.ts`, `types.ts`, `App.tsx`, `SourceControl.tsx`,
  `DiffSurface.tsx`, `SurfaceDock.tsx`, `TerminalSurface.tsx`, `styles.css`.

Acceptance:

- hooks schema и ошибки конфигурации покрыты тестами;
- session_start/turn_done не ломают lifecycle и не оставляют процесс running;
- audit trail совпадает с реальными действиями агента;
- полный test/typecheck/build зелёный после переноса на свежую базу.

### W0-B. MCP manager

- Ветка: `feature/mcp-manager`
- Worktree: `/Users/yafimkolyshkin/Desktop/agent-desktop-suite/agent-desktop-suite-worktrees/chat-hub-mcp-manager`
- Brief для отправки исполнителю: `TASKS-FOR-GROK.md` в корне этого worktree.
- Нельзя писать второй MCP host/client; Hub только управляет конфигурацией CLI.
- Нельзя дублировать hooks, worktrees, Browser или Actions.

Acceptance берётся из `TASKS-FOR-GROK.md`: `.chathub/mcp.json`, sealed env, materialize для
Claude/Codex/OpenCode, status, Settings → Connections, IPC/preload/dev-mock и тесты.

## 5. Wave 1 — независимые feature worktree

### W1-A. Карточная галерея вложений

- Ветка: `feat/attachment-card-gallery`
- Worktree: `/Users/yafimkolyshkin/Desktop/agent-desktop-suite-worktrees/chat-hub-attachments`
- Suggested commits:
  1. `feat(attachments): persist structured message attachment metadata`
  2. `feat(chat): add attachment card gallery and navigable lightbox`
  3. `test(attachments): cover persistence and gallery helpers`

Scope:

- добавить `MessageAttachment` и `ChatMessage.attachments?`;
- metadata вычислять/валидировать в main, не доверять renderer;
- сохранять в `state.json` только path/name/size/kind/mime, без base64/data URL;
- реализовать настоящий drag/drop через безопасный preload bridge;
- единый `AttachmentGallery` для composer и user-message;
- карточки 96–140 px, `object-fit: cover`, имя, размер, loading/error/missing;
- remove только до отправки;
- lightbox: original ratio, prev/next/count, Escape/arrows, zoom/reset, focus return;
- thumbnail загружать лениво; original — только при открытии lightbox;
- не менять текущую передачу абсолютных путей провайдерам.

Ownership:

- `src/shared/types.ts`
- attachment-часть `src/main/session-manager.ts` и при необходимости узкий IPC/preload bridge
- новые attachment-компоненты
- attachment-часть `ChatView.tsx`, CSS и focused tests

Не делать: pasted-file GC, Browser screenshots, изменение semantics SVG/GIF у провайдеров.

Acceptance:

- picker, paste и drop нескольких файлов работают без дублей;
- attachments-only отправка работает;
- карточки остаются в transcript после reload/restart;
- удалённый/недоступный файл даёт стабильную error card;
- в persisted JSON нет `data:image` и payload файла;
- keyboard/accessibility lightbox проверены;
- приложены before/after screenshots composer, transcript и lightbox.

### W1-B. Developer menu и main logs

- Ветка: `feature/developer-menu-diagnostics`
- Worktree: `/Users/yafimkolyshkin/Desktop/agent-desktop-suite-worktrees/chat-hub-developer-menu`
- Suggested commit: `feat: add developer menu and diagnostics`

Scope:

- новый main-only `src/main/developer-menu.ts`;
- новый небольшой rotating/redacting `src/main/main-log.ts`, если показывается файл логов;
- native menu: Toggle DevTools, Reload, Force Reload, Reveal main log;
- renderer/guest context-menu Inspect Element с корректными координатами;
- действия безопасно no-op для отсутствующего/destroyed window;
- короткая `docs/developer-tools.md`.

Ownership:

- новые main-модули;
- в `src/main/index.ts` только import + один вызов installer;
- `tests/developer-menu.test.ts`.

Не делать: IPC/preload, generic `executeJavaScript`, произвольный webContents id/path,
диагностический snapshot MCP/session state. Это отдельная интеграция после MCP.

Acceptance:

- menu template и shortcuts покрыты unit tests;
- `Cmd+Opt+I`, reload и force reload работают в packaged app;
- Inspect открывает правильный renderer/guest target;
- лог существует, ротируется и не содержит токены/секреты.

### W1-C. Session worktrees — фундамент git-flow

- Ветка: `feature/session-worktrees`
- Worktree: `/Users/yafimkolyshkin/Desktop/agent-desktop-suite-worktrees/chat-hub-session-worktrees`
- Suggested commits:
  1. `feat(git): add safe session worktree lifecycle`
  2. `feat(sessions): bind session identity to branch and worktree`
  3. `feat(ui): expose session checkout state`

Scope:

- optional branch/worktree при создании сессии;
- `repoRoot`, `baseBranch`, `branch`, `worktreePath`, `worktreeState` в `SessionMeta`;
- безопасный slug и collision handling;
- adapter cwd = worktree path;
- list/prune/remove/repair dead worktree;
- cleanup с жёстким отказом для dirty/unpushed без explicit confirmation;
- badges/controls в NewSession, Sidebar и TopBar;
- restart восстанавливает тот же worktree;
- исправить permission creation bug: выбор в New Session должен стать per-session, а не менять
  глобальную настройку всех новых/старых сессий.

Не делать: push/PR, Actions runner, per-hunk patching.

Acceptance:

- две сессии одного repo получают разные branch/cwd и могут править параллельно;
- base branch остаётся неизменной;
- restart сохраняет привязку;
- dirty/unpushed cleanup блокируется;
- no-git folder имеет честный unsupported state;
- focused temp-repo tests + полный gate зелёный.

### W1-D. Project Actions core

- Ветка: `feature/project-actions`
- Worktree: `/Users/yafimkolyshkin/Desktop/agent-desktop-suite-worktrees/chat-hub-project-actions`
- Suggested commits:
  1. `feat(actions): add project action store and runner`
  2. `feat(actions): add action editor and run surface`

Scope:

- `.chathub/actions.json`, versioned schema: id/name/command/shortcut/previewUrl/
  runOnWorktreeCreate/openPreview;
- runner lifecycle queued/running/success/error/cancelled;
- cwd строго project/worktree root;
- bounded stdout/stderr log, timeout и terminate process tree;
- editor + toolbar launch + run result UI;
- shortcut collision и URL validation;
- exported `onWorktreeCreated` hook, но не интегрировать его до принятия W1-C;
- preview contract должен открывать Browser surface, не внешний браузер по умолчанию.

Не делать: hooks event system (оно уже в другой ветке), cron/cloud automations, shell execution в
renderer.

Acceptance:

- Test/Typecheck/Dev/Build-подобные actions создаются и запускаются;
- cancel останавливает дерево процессов;
- log cap/timeout/invalid config покрыты тестами;
- duplicate shortcut и invalid preview URL отклоняются;
- UI явно говорит, что команда выполняется с правами проекта.

## 6. Wave 2 — после стабилизации контрактов

### W2-A. Browser local preview

- Ветка: `feature/browser-local-preview`
- Base: свежий `main` после Wave 0; может разрабатываться параллельно MCP при namespaced API.
- Worktree: `/Users/yafimkolyshkin/Desktop/agent-desktop-suite-worktrees/chat-hub-browser-preview`
- Suggested commits:
  1. `feat: detect local preview servers`
  2. `feat: upgrade browser surface controls`

Scope:

- fixed-argv `lsof` detector на macOS, без shell; валидировать ports 1..65535;
- typed `src/shared/browser-runtime.ts` и namespaced preload browser API;
- регистрация через `registerSurfaceIpc`, без изменений `src/main/index.ts`;
- port list/chips, manual refresh, deterministic unsupported/error state;
- настоящие webview navigation events, back/forward/reload/loading/error/address sync;
- Open in system browser, explicit screenshot, zoom/fullscreen;
- session/project preview state без протекания между сессиями;
- отдельная guest partition; deny-by-default permissions/downloads;
- renderer также отклоняет unsupported scheme, main остаётся authoritative.

Acceptance:

- `python3 -m http.server 4173 --bind 127.0.0.1` появляется и открывается;
- redirect/link обновляют адрес и history;
- остановленный server даёт понятную ошибку;
- screenshot создаётся только по явному клику и имеет size cap;
- packaged webview проверен через `pnpm pack:mac`, не только iframe fallback.

### W2-B. Browser annotations

- Ветка: `feature/browser-annotations`
- Base: только после merge Browser local preview.
- Scope: SVG/canvas overlay без инъекции в guest page; rectangle/arrow/text; undo/redo/clear;
  versioned normalized coordinates + URL/viewport metadata; composed screenshot; attach через уже
  существующий `savePastedImage`.

Acceptance: marks не съезжают после resize по зафиксированной zoom policy; screenshot содержит
страницу и annotations; persistence ограничена per session + URL; приложен annotated PNG.

### W2-C. Git publish flow

- Ветка: `feature/git-publish-flow`
- Base: после Session worktrees.
- Scope: push `-u`, gh detection/auth, editable PR title/body/base, draft, amend, stacked base,
  review-before-push gate. Network tests запрещены: temp bare remote + fake `gh` binary.

Acceptance: gate блокирует publish до review; argv snapshot корректен; missing/auth errors понятны;
реальный push/PR допускается только в disposable repo с явным разрешением.

### W2-D. Session catalog и command center

Разделить на две ветки:

- `feature/session-catalog`: `archivedAt` в main persistence, migration из localStorage,
  `needs_attention` из реальных pending permission/input вместо мёртвого production Wait.
- `feature/command-center`: после стабилизации API MCP/Actions/Git; registry-backed `Cmd+K` для
  sessions, actions, git publish, MCP/settings и UI-команд с disabled reason.

Transcript archive (>200, pagination, global search) — отдельная risky persistence-задача после
этого спринта, а не довесок к UI-фильтрам.

## 7. Порядок интеграции

Рекомендуемый порядок в release-candidate worktree:

1. hooks/audit trail;
2. Developer menu;
3. Session worktrees;
4. MCP manager;
5. attachment gallery;
6. Project Actions core + узкая интеграция `onWorktreeCreated`;
7. Browser local preview;
8. Browser annotations;
9. Git publish flow;
10. session catalog;
11. command center;
12. release validation.

MCP и Browser должны использовать namespaced модули, чтобы конфликт в preload свёлся к
композиции двух API. Одновременно редактировать `App.tsx`/`styles.css` нескольким веткам нельзя:
интегратор переносит новые компоненты, затем делает один осмысленный glue-коммит.

## 8. Что собрать с каждого worktree

Исполнитель возвращает `HANDOFF.md` или сообщение строго такого вида:

```md
# Handoff

- Task:
- Branch:
- Worktree (absolute path):
- Base SHA:
- Final HEAD SHA:
- Commits, in order:

## Changed files

- ...

## Contract / migration

- schema/API changes
- backward compatibility
- rollback/cleanup

## Verification

- `pnpm test`: command + exact count/result
- `pnpm typecheck`: result
- `pnpm build`: result
- focused tests: command + exact result
- `git diff --check`: result
- `git status --short`: expected empty

## Manual acceptance

- [x] scenario — evidence
- [ ] scenario — reason not run

## Visual evidence

- absolute screenshot/video paths
- sanitized fixture/config paths

## Security and destructive behavior

- secrets/logging/shell/network/deletion decisions

## Known gaps and merge forecast

- limitations/TODO
- expected conflicts by file
```

Интегратор принимает ветку только если `git status --short` пуст, все три общих gate зелёные,
acceptance отмечена pass/fail, а UI-задача содержит визуальное доказательство.

## 9. Release-candidate worktree

- Ветка: `integration/chat-hub-daily-driver`
- Worktree: `/Users/yafimkolyshkin/Desktop/agent-desktop-suite-worktrees/chat-hub-release`
- Интегратор не добавляет новые фичи. Он cherry-pick/rebase только принятые коммиты, объясняет
  каждый конфликт и создаёт отдельные integration-fix коммиты.

Финальный автоматический gate:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm pack:mac
git diff --check
git status --short
```

Финальный ручной smoke в собранном Chat Hub:

1. создать проект и две worktree-сессии одного repo;
2. проверить разные ветки/cwd и параллельные правки;
3. paste/drop несколько screenshots, отправить и перезапустить app;
4. открыть lightbox, zoom и navigation;
5. включить MCP server с dummy secret и проверить materialized config без секрета в каноне;
6. запустить `Dev` Action, увидеть log и открыть обнаруженный localhost;
7. сделать Browser screenshot, annotation и прикрепить его в chat;
8. открыть Developer menu, DevTools и main log;
9. проверить diff/review gate; push/PR — только в disposable repo;
10. перезапустить приложение и убедиться, что session/worktree/archive state сохранился.

Release evidence:

- final SHA и полный cherry-pick order;
- rationale всех конфликтов;
- exact outputs gate;
- путь к `.app`/artifact;
- screenshots всех ключевых сценариев;
- sanitized sample `.chathub/mcp.json`, `.chathub/actions.json` и persisted message attachment;
- `pnpm status:mac` после установки, если установка была отдельно разрешена.

Только после этого release-ветку можно переносить в `main` и устанавливать как локальное
приложение вместо ведения ежедневной работы из Codex UI.
