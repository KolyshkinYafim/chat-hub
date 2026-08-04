# Chat Hub — актуальный статус и backlog

**Проверено:** 2026-08-04, `origin/main` `6d7861d`.

Локальная release-проверка этого состояния: `pnpm typecheck` ✅, полный Vitest ✅ (live-тесты
провайдеров пропускаются без явного opt-in), `pnpm build` ✅.

## Готово

### Провайдеры и runtime

- Claude Code, Grok Build, OpenCode и Codex работают через реальные CLI-адаптеры.
- Есть live auth/version probes, shadow-home аккаунты, sealed API keys и binary-path overrides.
- Каталоги моделей живые для Grok/OpenCode/Codex; Codex использует app-server `model/list`,
  фильтрует retired-модели и передаёт доступные reasoning efforts.
- Очередь сообщений, честные статусы, watchdog, остановка при shutdown, native resume,
  usage/cost на turn и сессию.
- Structured tool/file/plan/review items, diff-карточки и audit trail действий агента.

### Рабочее пространство

- Sidebar проектов/сессий, поиск транскрипта, ⌘K switcher, first-run wizard.
- Browser, Terminal, Files, Diff и Board surfaces.
- Paste/drag-drop attachments, карточная галерея, lightbox и user-message previews.
- In-app Allow/Deny, waiting-input для структурированных провайдерских запросов.
- MCP manager с project scope и sealed env secrets.
- Project hooks `.chathub/hooks/*.json` с shell/prompt actions и отображением запусков.

### Git и доставка

- Опциональные branch + worktree на сессию в `~/.chathub/worktrees`.
- Удаление clean worktree при удалении сессии; dirty checkout сохраняется и логируется.
- Source Control: repository picker, stage/unstage, diff, branch switch, commit.
- Push/Create PR через `gh`, draft PR, review gate перед публикацией и детерминированное
  PR-body из log/diff/status.
- Список worktrees, dirty/stale markers, безопасное удаление и prune.
- Transcript overflow в `archive.jsonl` с lazy loading.
- macOS install/build с commit identity и ad-hoc signing для текущего устройства.

## Backlog для изолированных агентских worktrees

Каждая задача ниже должна приходить отдельным PR с тестами, `typecheck`, полным Vitest и build.

### P1 — Git/review

- Amend последнего commit; confirmation, если commit уже запушен.
- Выбор PR base branch и stacked PR между сессиями.
- Per-hunk approval поверх существующего whole-snapshot publish gate.
- Опциональный AI-generated PR title/body с детерминированным fallback.
- Guided export/backup для dirty worktree перед ручным удалением.

### P2 — Контекст и команды

- Редактор `AGENTS.md`/`CLAUDE.md` с preview точного контекста следующего prompt.
- Discovery и вставка project skills/slash-команд в composer.
- Persist sidebar archive state в `SessionMeta`, а не только в localStorage.

### P3 — Kiro-подобное планирование

- Spec mode: prompt → `requirements.md` → `design.md` → `tasks.md`, связь с Board.
- Dependency-aware task waves: независимые задачи запускаются параллельно в worktrees.
- Named subagent presets и двухагентная verification/comparison run.
- Complexity-based auto-routing модели с ручным override.
- Usage dashboard по дням, проектам, провайдерам, моделям и reasoning effort.

### P4 — Платформа

- Auto-update для signed/notarized distribution.
- Windows/Linux builds.
- Headless `chat-hub run --spec …` для CI.
- Local HTTP/WS + PWA remote access.

Для текущего Mac P4 не блокирует daily driver и остаётся отдельным треком.
