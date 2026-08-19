# T3 Code — инвентаризация функционала и сравнение с Chat Hub

**Проверено:** 2026-08-19 по shallow-клону pingdotgg/t3code, HEAD `f2d5fc9` (19.08.2026) —
клон фактически совпадает с последним nightly (`v0.0.34-nightly.20260819.1133`). Пути T3 даны
от корня их репозитория, пути Chat Hub — от корня chat-hub. Каждый пункт проверен в коде.
Утверждения вида «не нашёл в коде» означают именно это, а не «фичи нет наверняка».

## 1. Коротко о T3 Code

- «Agent harness control surface»: сервер (`apps/server`, npm-пакет `t3`, Node) владеет
  агентами, git, терминалами и файлами. Клиенты — web (`apps/web`), Electron-обёртка
  (`apps/desktop`), мобилка (`apps/mobile`, Expo RN) — говорят с ним по Effect RPC поверх
  одного WebSocket (`packages/contracts/src/rpc.ts`, `docs/internals/overview.md`).
- Своего рантайма агентов нет: 5 драйверов поверх чужих CLI/SDK
  (`apps/server/src/provider/builtInDrivers.ts`) — Codex через app-server JSON-RPC
  (`packages/effect-codex-app-server`), Claude через `@anthropic-ai/claude-agent-sdk`
  (`apps/server/src/provider/Layers/ClaudeAdapter.ts`), Cursor и Grok через ACP
  (`packages/effect-acp`, `apps/server/src/provider/acp/`), OpenCode через его сервер.
- Состояние — event-sourced: команды → события → проекции в SQLite, один worker-fiber
  (`apps/server/src/orchestration/decider.ts`, `projector.ts`).
- `native/` — не Electron-код: `libghostty-vt` (C ABI Ghostty для терминала, WASM на web)
  и `resource-monitor` (standalone Rust-бинарь для телеметрии CPU/RAM).
- Релизы: stable-теги + nightly каждые ~3 часа (сегодня 4 nightly за день, по `gh release
  list`). Автообновление — electron-updater с каналами latest/nightly
  (`apps/desktop/src/electron/ElectronUpdater.ts`), фид — GitHub Releases
  (`latest*.yml`/`nightly*.yml` + blockmap, `docs/operations/release.md`).

## 2. Полный список функционала T3 Code

### Sessions / Threads
- Thread = ветка/worktree + провайдер + модель, привязан к проекту — `packages/contracts/src/orchestration.ts` (OrchestrationThread)
- Lifecycle: settled/unsettled (auto по концу turn + ручной override), archive, snooze до времени, pin с drag-reorder между устройствами — `packages/contracts/src/orchestration.ts:380-470,700-740`
- Checkpoint на каждый turn (скрытые git refs) + revert workspace и разговора — `apps/server/src/orchestration/Layers/CheckpointReactor.ts`, `apps/server/src/vcs/VcsDriver.ts`
- Diff за turn прямо в чате (дерево изменённых файлов) — `apps/web/src/components/chat/ChangedFilesTree.tsx`
- Авто-генерация и regenerate заголовков тредов (LLM, дешёвая модель per provider) — `apps/server/src/textGeneration/ClaudeTextGeneration.ts`, `docs/user/thread-sidebar.md`
- Статус-пилюли в сайдбаре: Working / Pending Approval / Awaiting Input / Connecting + PR-статус + «терминал ещё работает» — `apps/web/src/components/Sidebar.logic.ts:638`, `ThreadStatusIndicators.tsx`
- Несколько environments (машин) одновременно, треды сливаются в один сайдбар — `docs/internals/overview.md`, `packages/client-runtime`
- Draft-треды как отдельные роуты с hero-экраном — `apps/web/src/routes/_chat.draft.$draftId.tsx`, `chat/DraftHeroHeadline.tsx`

### Composer
- Лимит 120k символов с точным счётчиком превышения — `apps/web/src/components/chat/composerSubmission.ts`, `docs/user/composer.md`
- Model picker: инстансы провайдеров, поиск, accent-цвета аккаунтов, «locked» совместимость при продолжении треда — `chat/ProviderModelPicker.tsx`, `ModelPickerContent.tsx`
- Traits picker: драйвер декларирует опции (select/boolean) — Codex: Reasoning + Service Tier, Claude: ultrathink через префикс промпта — `chat/TraitsPicker.tsx`, `apps/server/src/provider/Layers/CodexProvider.ts:115-181`, `packages/contracts/src/model.ts`
- Slash-команды + skills (`$`) + `@`-упоминания файлов + drag файла из дерева в композер — `chat/ComposerCommandMenu.tsx`, `chat/composerMentionDrag.ts`, `files/fileTreeDragMention.ts`
- Prompt stash (⌘S: отложить черновик с картинками, вернуть позже) — `chat/ComposerStashMenu.tsx`, `apps/web/src/promptStashStore.ts`
- Pending-контексты в композере: выделения из терминала, элементы UI из preview, комментарии из diff-ревью, аннотации на preview — `chat/ComposerPendingTerminalContexts.tsx`, `ComposerPendingElementContexts.tsx`, `ComposerPendingReviewComments.tsx`, `ComposerPreviewAnnotationCards.tsx`
- Approvals инлайн в композере (accept / acceptForSession / decline) — `chat/ComposerPendingApprovalPanel.tsx`, `orchestration.ts` (ProviderApprovalDecision)
- Context window meter — `chat/ContextWindowMeter.tsx`
- Permission mode per thread (Supervised / Auto-accept edits / Auto / Full access) — `docs/user/permission-modes.md`, `chat/CompactComposerControlsMenu.tsx`
- Plan mode (interactionMode default/plan) + карточка предложенного плана + follow-up баннер — `orchestration.ts:127`, `chat/ProposedPlanCard.tsx`, `ComposerPlanFollowUpBanner.tsx`

### Transcript rendering
- Виртуализированный timeline со scroll anchoring — `chat/MessagesTimeline.tsx`, `chat/timelineScrollAnchoring.ts`
- «Working for Xs · <шаг плана>» — живой ряд с таймером вне React-коммитов — `chat/MessagesTimeline.tsx:1282`
- Buffered vs streaming доставка ответа (спилл на 24k символов) — `docs/internals/providers.md`, `orchestration.ts` (AssistantDeliveryMode)
- Subagent fleet panel: живой список сабагентов с активностью, токенами, моделью — `apps/web/src/components/AgentsPanel.tsx`
- Inline-рендер скиллов, баннеры ошибок треда и статуса провайдера, sync-pill — `chat/SkillInlineText.tsx`, `ThreadErrorBanner.tsx`, `ProviderStatusBanner.tsx`, `ThreadSyncStatusPill.tsx`
- Копирование сообщения, кастомные file-type иконки (pierre-icons) — `chat/MessageCopyButton.tsx`, `chat/PierreEntryIcon.tsx`

### Surfaces / Panels
- Правая панель с табами (preview/diff/files/PR/agents) + maximize по хоткею — `apps/web/src/components/RightPanelTabs.tsx`, `docs/user/keybindings.md`
- Встроенный browser preview (desktop webview): zoom, favicon, appearance, unreachable-стейты — `apps/desktop/src/preview/BrowserSession.ts`, `apps/web/src/components/preview/PreviewPanel.tsx`
- Автообнаружение локальных dev-серверов сканом портов — `apps/server/src/preview/PortScanner.ts`, `preview/useDiscoveredLocalServers.ts`
- Element picker + аннотации поверх preview → контекст агенту — `apps/desktop/src/preview/PickPreload.ts`, `PickedElementPayload.ts`
- Агент водит preview через MCP: 14 тулов (open/navigate/click/type/press/scroll/evaluate/wait_for/snapshot/resize/set_appearance/recording_start|stop/status), Playwright-runtime в webview, визуальный курсор агента — `apps/server/src/mcp/toolkits/preview/tools.ts`, `apps/desktop/src/preview/PlaywrightInjectedRuntime.ts`, `preview/AgentBrowserCursor.tsx`
- Preview mini-player (PiP при скролле в чат) — `preview/ThreadPreviewMiniPlayer.tsx`, `apps/desktop/src/preview-pip-preload.ts`
- Терминалы: server-side PTY, рендер через Ghostty VT (WASM, Canvas), per-thread drawer — `apps/server/src/terminal/Manager.ts`, `apps/web/src/terminal/ghostty/`, `native/libghostty-vt/`, `ThreadTerminalDrawer.tsx`
- File browser + просмотр/редактирование файла с save-координацией, reveal строки, комментарии к строкам файла — `files/FileBrowserPanel.tsx`, `files/fileSaveCoordinator.ts`, `files/fileCommentAnnotations.ts`
- Diff panel с комментариями к строкам, уходящими в композер — `apps/web/src/components/DiffPanel.tsx`, `diffs/DiffCommentAnnotation.tsx`
- Полноценный PR-клиент: список с фильтрами, timeline, checks, reactions, reviewer picker, правка title/body/комментариев в Markdown — `apps/web/src/components/pullRequest/*`, `apps/web/src/routes/_chat.pull-requests.tsx`
- Open in editor: VS Code/Cursor/Zed/JetBrains/Kiro/Trae + remote-SSH deep links — `packages/contracts/src/editor.ts`, `chat/OpenInPicker.tsx`

### Git & worktrees
- VCS driver contract + git-реализация, worktree per thread, default env mode: проект → t3.json → глобально — `apps/server/src/vcs/GitVcsDriver.ts`, `packages/contracts/src/t3ProjectFile.ts`
- Branch toolbar: селекторы ветки/environment/env-mode, «new thread in this worktree» — `apps/web/src/components/BranchToolbar.tsx`
- Commit/push/create PR из тулбара, AI-подсказки title/description — `apps/web/src/components/GitActionsControl.tsx`, `docs/user/source-control.md`
- 4 хостинга: GitHub (gh), GitLab (glab), Bitbucket (token), Azure DevOps (az) + clone и publish репозитория — `apps/server/src/sourceControl/`, `docs/user/source-control.md`
- Индикация и очистка worktree (clean/dirty) — `apps/web/src/worktreeCleanup.test.ts`, `hooks/useThreadActions.ts`
- Per-hunk staging — не нашёл в коде (только комментарии к diff, не staging)

### Actions / Automations
- Project scripts: id/name/command/icon (6 иконок), правка в UI — `orchestration.ts:198-226`, `apps/web/src/components/ProjectScriptsControl.tsx`, `projectScriptEditor.tsx`
- Хоткей на каждый скрипт: `script.{id}.run` в keybindings — `docs/user/keybindings.md`
- `runOnWorktreeCreate`: setup-скрипт стартует в терминале нового worktree — `apps/server/src/project/ProjectSetupScriptRunner.ts`
- `previewUrl` + `autoOpenPreview`: скрипт открывает preview на URL при запуске — `packages/contracts/src/t3ProjectFile.ts:45-56`
- Командный `t3.json` в корне репо с опубликованной JSON-схемой, импорт скриптов командой — `t3.json`, `t3ProjectFile.ts`
- Event-hooks в стиле Chat Hub (`.chathub/hooks`) — не нашёл в коде

### Providers / Models
- 5 драйверов: Codex, Claude, Cursor, Grok, OpenCode — `apps/server/src/provider/builtInDrivers.ts`, адаптеры в `provider/Layers/`
- Несколько инстансов одного провайдера: Codex shadow-home (2 аккаунта на общей истории), Claude через CLAUDE_CONFIG_DIR, env vars с sealed-секретами, binary path override, accent-цвет, blur email — `docs/user/providers-codex.md`, `providers-claude.md`, `settings/ProviderSettingsForm.tsx`, `RedactedSensitiveText.tsx`
- Живой каталог моделей от CLI + алиасы слагов + preferred defaults — `packages/contracts/src/model.ts`
- Claude skills: скан `<config>/skills`, `.agents/skills`, `.claude/skills` — `apps/server/src/provider/Drivers/ClaudeSkills.ts`
- Usage page: API-эквивалент стоимости, cache savings, разрезы по провайдерам/моделям, 24h/7/30/90 дней, чтение локальной истории сессий CLI — `apps/server/src/usage/usageAggregation.ts`, `apps/web/src/routes/usage.tsx`, `docs/user/usage.md`
- Статус авторизации провайдера с подсказкой команды логина — `settings/providerStatus.ts`, `docs/user/install.md`

### Permissions / Sandbox
- 4 режима, маппинг на нативные санбоксы провайдеров (Codex approval policy + sandbox level, Claude auto mode, fallback к Supervised) — `docs/user/permission-modes.md`
- Per-method авторизация RPC по scope (сокет ≠ право на всё) — `docs/internals/environment-auth.md`, `apps/server/src/ws.ts`
- Собственного OS-санбокса нет — полагаются на санбоксы CLI

### Attachments / Media
- Картинки в сообщении: grid 2 колонки, lightbox со стрелками и Escape — `chat/MessagesTimeline.tsx:982`, `chat/ExpandedImageDialog.tsx`
- Drop файлов из workspace и с диска, локальный object-URL до промоушена в серверный asset — `chat/workspaceFileDrop.ts`, `ChatView.tsx:2337-2400`
- Подписанные короткоживущие asset-URL (attachment/workspace-file/favicon) — `packages/contracts/src/assets.ts`

### Search
- Command palette (⌘K): треды, проекты, ветки, сообщения пользователя и финальные ответы — по всем подключённым environments — `apps/web/src/components/CommandPalette.tsx`, `docs/user/keybindings.md`
- File picker (mod+p) и поиск по содержимому проекта (mod+shift+f) — `files/ProjectFilePicker.tsx`, `search/ProjectContentSearchDialog.tsx`
- Поиск по настройкам — `settings/settingsSearch.ts`

### Settings
- Редактор keybindings + JSON-файл с `when`-выражениями (terminalFocus и т.п.) — `settings/KeybindingsSettings.tsx`, `docs/user/keybindings.md`
- Темы: набор встроенных, импорт, плавающий theme editor с Inspect-пипеткой по живому UI — `settings/ThemeSettings.tsx`, `ThemeImportDialog.tsx`, `ThemeEditorPanel.tsx`, `themeInspector.ts`
- Выбор шрифтов, иконка проекта (авто-детект favicon + ручной выбор файла) — `settings/FontFamilyPicker.tsx`, `docs/user/project-settings.md`
- Диагностика + resource telemetry (Rust-монитор процессов вместо ps-поллинга) — `settings/ResourceTelemetryDiagnostics.tsx`, `native/resource-monitor/`, `docs/internals/resource-telemetry.md`
- Страница архивных тредов — `apps/web/src/routes/settings.archived.tsx`

### Updates / Distribution
- electron-updater: каналы latest/nightly, ручной download (autoDownload=false), differential updates, детект arm64-под-Rosetta с переездом на arm64-пакет — `apps/desktop/src/updates/DesktopUpdates.ts`, `updateChannels.ts`
- In-app UI: toast + пилюля в сайдбаре + release notes (парсинг и лимиты) — `apps/web/src/components/desktopUpdate.toast.tsx`, `sidebar/SidebarUpdatePill.tsx`, `apps/desktop/src/updates/releaseNotes.ts`
- CI-релиз: nightly-проверка каждые 3 часа, 4 артефакта (mac arm64/x64 DMG, Linux AppImage, Win NSIS), mac notarization, Windows Azure Trusted Signing, npm `t3` c dist-tag latest/nightly, деплой hosted web на Vercel — `.github/workflows/release.yml`, `docs/operations/release.md`
- Дистрибуция: winget, brew cask, AUR (stable+nightly) — `packaging/aur/`, `docs/user/install.md`
- Server self-update по предупреждению о version skew: download → restart → rollback c снапшотом БД — `apps/server/src/cloud/selfUpdate.ts`, `docs/user/updating.md`
- Background service (systemd user unit / launchd) со stable-launcher'ом — `apps/server/src/background/`, `docs/user/background-service.md`
- Hold-to-quit (⌘Q с удержанием, как в Chrome) — `apps/desktop/src/window/QuitHold.ts`

### Mobile / Remote
- Пейринг QR/одноразовый токен, `t3 pair`, `t3 serve`, `t3 auth` (ревокация сессий) — `docs/user/remote-access.md`
- Tailscale-эндпоинты + Tailscale Serve HTTPS как opt-in — `apps/desktop/src/backend/tailscaleEndpointProvider.ts`, `packages/tailscale/`
- SSH-launch удалённого сервера из desktop (probe, запуск, port-forward) и WSL-бэкенд — `apps/desktop/src/ssh/DesktopSshEnvironment.ts`, `apps/desktop/src/wsl/`
- T3 Connect: Clerk-аккаунт + relay на Cloudflare + managed-туннели + push — `docs/internals/t3-connect.md`, `infra/relay/`, `apps/server/src/relay/`
- Мобилка (Expo, iOS/Android): треды, diffs, терминал (Ghostty через JNI), usage, темы, push-уведомления «агенту нужно внимание» — `apps/mobile/src/features/` (в т.ч. `agent-awareness/notificationPermissions.ts`)
- Hosted web app `app.t3.codes` с pairing по URL — `apps/web/`, `docs/user/remote-access.md`

### Misc
- Всё на Effect (сервер, desktop, клиентский рантайм), собственный oxlint-плагин — `oxlint-plugin-t3code/`
- Маркетинговый сайт на Astro — `apps/marketing/`
- Swift-эксперимент с рендером сообщений — `experiments/messages-glass-lab/`
- Discord-нотификации о релизах — `scripts/notify-discord-release.ts`

## 3. Матрица: T3 Code vs Chat Hub

Chat Hub проверен по `src/` (не по докам). Вердикты: ✅ паритет, ❌ у нас нет, 🟡 частично, 💪 у нас лучше.

| Фича | T3 Code | Chat Hub | Вердикт |
|---|---|---|---|
| Multi-CLI | Codex/Claude/Cursor/Grok/OpenCode | Claude/Codex/Grok/OpenCode (`src/main/adapters/`) | 🟡 нет Cursor |
| Codex app-server runtime | effect-codex-app-server | `src/main/codex-protocol/` | ✅ |
| Model + effort picker | TraitsPicker, driver-declared опции | `ComposerMenu.tsx` (model/mode/permission/effort) | ✅ |
| Permission modes per session | 4 режима | permission pane в ComposerMenu + Allow/Deny broker | ✅ |
| Inline approvals | в композере | in-app + зеркало в notch island (`permission-broker.ts`) | 💪 island |
| Worktree per session | env mode + t3.json default | `NewSessionDialog` + `git.ts` | ✅ |
| Worktree cleanup | индикация + удаление | clean remove + stale prune (`SourceControl.tsx`) | ✅ |
| Checkpoints + revert turn'а | git refs, revert workspace+разговора | нет (grep `checkpoint` в src пуст) | ❌ |
| Lifecycle тредов | settled/unsettle/snooze/pin/archive, синк между устройствами | только archive (localStorage) + pinned projects | 🟡 |
| Авто-заголовки тредов | LLM + regenerate | нет | ❌ |
| Live «агент работает» | Working-row: таймер + шаг плана + пилюли в сайдбаре | `LiveStepTicker.tsx` (шаг + план + elapsed) + `StatusDot` | ✅ |
| Subagent fleet view | AgentsPanel | нет (только доки SUBAGENT-VIEW.md) | ❌ |
| Attachments grid + lightbox | 2-col grid, стрелки | `AttachmentGallery.tsx` + `AttachmentLightbox.tsx` | ✅ |
| Агентный браузер через MCP | 14 тулов + Playwright runtime + курсор агента + recording | 13 тулов, ref-дерево, sendInputEvent (`browser-mcp.ts`, `surfaces/browser-control.ts`) | ✅ ядро, у T3 + recording/cursor |
| Element pick + annotate preview → композер | есть | нет | ❌ |
| Preview URL из action/скрипта | previewUrl + autoOpenPreview | нет (hooks не открывают browser surface) | ❌ |
| Terminal surface | server PTY + Ghostty WASM | node-pty локально (`surfaces/terminal.ts`) | ✅ локально |
| Per-hunk staging | не нашёл в коде | stage/unstage hunk (`SourceControl.tsx:60-81`) | 💪 |
| PR-клиент внутри приложения | список/чеки/reactions/правка PR | только create PR + review gate | ❌ |
| Diff-комментарии → композер | DiffCommentAnnotation | нет (есть audit trail) | ❌ |
| Транскрипт-поиск | ⌘K ищет по сообщениям всех сред | `search.ts` + `message-archive.ts` | ✅ |
| Command palette | треды/проекты/ветки/сообщения | `CommandPalette.tsx` | ✅ |
| Project file search / content search | mod+p / mod+shift+f | нет | ❌ |
| Custom keybindings | JSON + when-выражения + UI | фиксированные (`ShortcutsOverlay.tsx`) | ❌ |
| Themes + theme editor | встроенные + импорт + inspect | один тёмный стиль (`styles.css`) | ❌ |
| Usage dashboard | страница с разрезами | raw usage в persistence, UI нет | ❌ |
| Context window meter | есть | нет | ❌ |
| Prompt stash | ⌘S | нет | ❌ |
| Slash-команды + skills в композере | есть | нет (backlog подтверждён) | ❌ |
| Hooks-автоматизация на события | не нашёл в коде | `.chathub/hooks` (`src/main/hooks.ts`) | 💪 |
| Board / kanban | нет | `surfaces/board.ts` + `BoardSurface.tsx` | 💪 |
| Voice input | не нашёл в коде | Handy-интеграция (`voice-handy.ts`) | 💪 |
| Notch island / Session Monitor | нет | JSONL-bridge (`bridge.ts`) | 💪 |
| Авто-update | полный конвейер | нет (grep electron-updater пуст) | ❌ |
| Remote / mobile | сервер+web+мобилка+Tailscale+Connect | нет | ❌ |
| Мультиаккаунты провайдера | shadow home, CONFIG_DIR, sealed env | shadow-home + sealed keys (`adapters/`, `secret.ts`) | ✅ |
| MCP manager | MCP-сервер свой (preview), менеджер чужих не нашёл | project scope + sealed secrets (`mcp.ts`) | 💪 |
| Первичный onboarding | pairing-флоу | `FirstRunWizard.tsx` | ✅ |

Итог: ядро (multi-CLI, worktrees, approvals, живой статус, attachments, агентный браузер)
у Chat Hub в паритете, а козыри — island, hooks, board, per-hunk, voice, MCP manager.
Разрыв — вокруг треда как долгоживущего объекта (lifecycle, checkpoints, заголовки),
поиска/палитры по контенту проекта, PR-клиента и всей платформенной обвязки
(update, remote, usage UI).

## 4. Что стоит забрать (ранжировано)

1. **Checkpoints + revert** — самая ценная страховка при Full access: каждый turn обёрнут
   git-ref'ами, revert откатывает и файлы, и разговор. У нас: main-модуль `checkpoints.ts`
   рядом с `git.ts` (ref `refs/chathub/<session>/<turn>`), кнопка Revert на turn-карточке
   в ChatView.
2. **Авто-заголовки сессий** — дёшево (haiku-класс через уже имеющиеся адаптеры) и
   ежедневно полезно в сайдбаре. У нас: hook в session-manager после первого turn,
   поле в SessionMeta, пункт Regenerate в контекст-меню Sidebar.
3. **Thread lifecycle (settled/unsettle)** — сайдбар делится на «требует внимания» и
   «улеглось» автоматически по концу turn'а, с ручным override. У нас: `settledAt` +
   `settledOverride` в SessionMeta (заодно закрывает P2-пункт про перенос archive из
   localStorage), секции в Sidebar.
4. **Project scripts с previewUrl** — то, что мы сейчас строим как actions: их схема
   (name/command/icon/runOnWorktreeCreate/previewUrl/autoOpenPreview, шаринг через
   checked-in файл) проверена жизнью. У нас: расширить `.chathub/` файлом `project.json`,
   запуск в Terminal surface, autoOpen Browser surface на previewUrl.
5. **Context window meter** — маленький индикатор, снимающий главный страх длинной
   сессии. Данные уже есть в usage-событиях адаптеров, рендер — полоска у композера.
6. **Prompt stash (⌘S)** — спасает набранный промпт при смене темы разговора. У нас:
   массив в localStorage/SessionMeta + пункт в ComposerMenu.
7. **Usage dashboard** — raw usage уже персистится (`persistence.ts`), T3 показывает
   ценность разрезов 24h/7d по моделям. У нас: HistorySurface-подобная страница по
   данным `adapters/usage.ts`.
8. **Diff-комментарии → композер** — комментируешь строки диффа, пачка уходит агенту
   одним сообщением. У нас: аннотации в DiffSurface, сбор в pending-блок композера.
9. **Скрипт при создании worktree** (`runOnWorktreeCreate`) — закрывает вечное «npm i в
   новом worktree». Подмножество п.4, можно сделать первым.
10. **Slash/skills discovery в композере** — T3 сканирует skills-каталоги Claude на диске
    (`ClaudeSkills.ts`), не полагаясь на CLI. У нас: тот же скан в main + меню по `/` и `$`.
11. **Кросс-look поиска: file picker + content search** — mod+p / mod+shift+f поверх
    существующего FilesSurface, результат открывается в FileViewer с reveal строки.
12. **Auto-update** — их конвейер (electron-updater + GitHub Releases feed + каналы)
    ровно ложится на наш P4: у нас уже есть `electron-builder.yml`, не хватает publish-
    конфига, `latest-mac.yml` в релизах и update-баннера.

## 5. Как у них решён X

### a) Project actions / automations (hotkeys, preview URL)
Скрипт — доменный объект проекта: `{id, name, command, icon, runOnWorktreeCreate,
previewUrl?, autoOpenPreview?}` (`packages/contracts/src/orchestration.ts:208`). Источника
два: личные скрипты в проекциях сервера и командный `t3.json` в корне репо
(`packages/contracts/src/t3ProjectFile.ts`, схема опубликована на t3.codes, лимит 50).
UI импортирует файл-скрипты в проект, дедуплицируя по команде/имени
(`apps/web/src/components/ProjectScriptsControl.tsx:75-118`). Запуск — не отдельный
раннер, а обычный серверный терминал: `ProjectSetupScriptRunner` открывает PTY в
worktree и пишет команду (`apps/server/src/project/ProjectSetupScriptRunner.ts`), поэтому
вывод виден в терминал-панели бесплатно. Каждый скрипт адресуем как команда
`script.{id}.run` и может получить хоткей (`docs/user/keybindings.md`). `previewUrl`
открывает встроенный browser preview, `autoOpenPreview` — сразу при старте скрипта
(honored только на desktop).

### b) Thread lifecycle (settled / unsettle / archive)
Три measured-состояния + два оверлея (`orchestration.ts:380-470`): `settledAt` ставится
автоматически, когда сессия уходит из `running` (проекция
`settledTurnStateForSessionStatus` в `apps/server/src/orchestration/projector.ts`),
`settledOverride: "settled" | "active" | null` — ручной сдвиг. Активность (новое сообщение,
старт сессии) снимает settled сервер-сайд: decider сам эмитит
`thread.unsettled(reason: "activity")`, клиентская команда несёт только `reason: "user"` —
клиент не может подделать нейтральный сброс. `snoozedUntil` — оверлей: тред остаётся
active, но прячется из инбокса до срока, причём таймер-пробуждение не порождает события —
клиенты сами перестают классифицировать его как snoozed. `pinnedAt` перекрывает всё и
кладёт тред в закреплённый блок с fractional-index порядком (`pinOrderKey`), который
синкается между устройствами. Archive — отдельная пара событий
`thread.archived/unarchived` со страницей в настройках.

### c) Attachment grid + lightbox
В сообщении пользователя картинки рендерятся сеткой `grid-cols-2` шириной до 420px
(`chat/MessagesTimeline.tsx:958-983`). Клик открывает `ExpandedImageDialog` — оверлей с
навигацией стрелками по кольцу (offset по модулю длины) и Escape
(`chat/ExpandedImageDialog.tsx`). Ключевая деталь — двухфазные URL: пока файл летит на
сервер, превью живёт на локальном object-URL, и `ChatView` держит handoff-мапу
`messageId → previewUrls`, промоутя их на подписанные серверные ссылки без мигания
(`ChatView.tsx:1388, 2337-2400`). Сами ссылки — короткоживущие signed asset-URL, которые
сервер выдаёт по ресурсу `{_tag: "attachment", attachmentId}`
(`packages/contracts/src/assets.ts`), так что транскрипт не хранит абсолютных путей.

### d) Auto-update end to end
Сборка: `.github/workflows/release.yml` — стабильный тег или nightly-проверка каждые
3 часа, 4 артефакта, mac notarization (Team ID + provisioning), Windows — Azure Trusted
Signing, подпись auto-detect по секретам (`docs/operations/release.md`). Фид: GitHub
Release с `latest*.yml`/`nightly*.yml` + `*.blockmap` (differential), per-arch манифесты
сливает `scripts/merge-update-manifests.ts`. Клиент: electron-updater
(`apps/desktop/src/electron/ElectronUpdater.ts`), канал = nightly-суффикс версии
(`updates/updateChannels.ts`), `autoDownload=false` — скачивание по кнопке. Стейт-машина
checking→available→downloading→downloaded с процентами и retry — чистые редьюсеры в
`updates/updateMachine.ts`, наружу это toast + пилюля в сайдбаре
(`apps/web/src/components/desktopUpdate.toast.tsx`, `sidebar/SidebarUpdatePill.tsx`) с
release notes, распарсенными и обрезанными в `updates/releaseNotes.ts`. Для тестов —
`scripts/mock-update-server.ts` и generic-фид на localhost. Отдельная ветка — сервер:
version-skew баннер в чате, self-update с launcher'ом и откатом вместе со снапшотом БД
(`apps/server/src/cloud/selfUpdate.ts`, `docs/user/updating.md`).

### e) Live-индикатор «что агент делает сейчас»
Два уровня. В транскрипте — синтетический ряд `kind: "working"`: три пульсирующие точки,
«Working for Xs» и текущий шаг плана через точку (`chat/MessagesTimeline.tsx:1282-1307`).
Таймер — self-ticking span, обновляющий textContent через setInterval, чтобы секундный тик
не вызывал React-коммитов во время стрима. `workingStepLabel` считается в `ChatView.tsx:2300`
из turn-плана (in-progress шаг). В сайдбаре — пилюля с приоритетом: Pending Approval >
Awaiting Input > Working (pulse) > Connecting (`Sidebar.logic.ts:638-677`), плюс отдельные
индикаторы «PR открыт/смержен» и «в треде ещё живёт терминальный процесс»
(`ThreadStatusIndicators.tsx`). Гранулярности «какой именно тул сейчас» в пилюле нет —
детали остаются в транскрипте, а для сабагентов есть свой fleet-view (`AgentsPanel.tsx`).

### f) Composer model/effort/speed picker — модель данных
`ModelSelection` = провайдер-инстанс + слаг модели + `options: Array<{id, value:
string|boolean}>` (`packages/contracts/src/model.ts`, легаси-объект мигрируется в массив).
Никаких зашитых опций в UI: каждый драйвер отдаёт для модели `optionDescriptors` —
select с choices/isDefault/currentValue или boolean. Codex строит их из живого
`model/list` app-server'а: «Reasoning» из `supportedReasoningEfforts` и «Service Tier» из
`serviceTiers`/`additionalSpeedTiers` с синтетической первой опцией «Standard»
(`apps/server/src/provider/Layers/CodexProvider.ts:115-181`). То есть «Speed/Service Tier:
Standard» — это дефолтный тир против платного «Fast»-тира Codex, и список приходит от
OpenAI, а не из T3. UI один и generic: `TraitsPicker` рендерит любые дескрипторы радио-
группами (`chat/TraitsPicker.tsx`). Спец-случай Claude — «ultrathink»: дескриптор с
`promptInjectedValues`, выбор не меняет флаги CLI, а префиксует промпт `Ultrathink:\n`
(`applyClaudePromptEffortPrefix` из `@t3tools/shared/model`).

---
*Оговорка: T3 движется nightly-темпом (несколько релизов в день), клон от 19.08.2026 —
отдельные детали могли уехать уже к моменту чтения. Chat Hub сверялся по рабочей копии
`src/` на ту же дату.*
