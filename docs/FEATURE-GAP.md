# Chat Hub vs Kiro, T3 Code и Panes — актуальная карта

**Проверено:** 2026-08-04, `origin/main` `6d7861d`.

Это reference-документ: галочка означает, что возможность уже есть в текущем коде и не должна
попадать в backlog повторно. Локальная проверка текущего `main`: typecheck ✅, полный Vitest ✅
(live-тесты провайдеров пропускаются без явного opt-in), production build ✅.

## Что уже готово в Chat Hub

### Агентное ядро

- Claude Code, Grok Build, OpenCode и Codex через реальные CLI-адаптеры.
- Live auth/version/model probes, shadow-home аккаунты, sealed API keys и binary overrides.
- Codex app-server runtime: live model catalog, retired-model filtering и per-model reasoning
  capabilities (Sol/Terra/Luna и доступные уровни effort приходят от runtime).
- Очередь сообщений, watchdog, честный event-bus status, shutdown recovery и native resume.
- Usage/cost на turn и сессию.
- Structured tool/file/plan/review items, readable diffs и agent audit trail.

### Поверхности и UX

- Sidebar проектов/сессий, archive, transcript search, ⌘K switcher, first-run wizard.
- Browser, Terminal, Files, Diff и Board surfaces.
- Paste/drag-drop attachments, карточная gallery, lightbox, loading/error states и previews
  внутри user messages.
- In-app Allow/Deny с зеркалированием в Session Monitor island.
- MCP manager с project scope и sealed server secrets.
- Project hooks `.chathub/hooks/*.json` (shell/prompt, matching, timeout, enabled) и их статус
  в terminal surface.

### Git / Panes-style delivery

- Опциональный branch/worktree на сессию: `chathub/<slug>-<id>` в
  `~/.chathub/worktrees/<project>/…`.
- При удалении сессии clean worktree удаляется; dirty worktree не уничтожается.
- Source Control умеет repository picker, stage/unstage, per-file diff, branch switch и commit.
- Push и Create PR через `gh`, draft flag, review gate до публикации.
- PR body fallback строится из commits, diff-stat и working-tree status.
- Worktree list показывает current/clean/dirty/stale, есть безопасный Remove и Prune.
- Audit trail показывает команды, file changes, tool calls, web/image actions, ошибки и running
  items рядом с Diff до commit/push.

## Матрица текущего состояния

| Возможность | Chat Hub сейчас | Комментарий |
|---|---:|---|
| Multi-CLI | ✅ | Claude, Grok, OpenCode, Codex |
| Live model catalog | ✅ | Grok/OpenCode/Codex live; Claude aliases stable |
| Reasoning levels | ✅ | Codex capabilities приходят от app-server |
| Queue / watchdog / honest status | ✅ | Покрыто тестами |
| Worktree-per-session | ✅ | Опционально в New Session |
| Worktree cleanup | ✅ | Clean remove + stale prune |
| Commit / Push / Create PR | ✅ | Source Control + `gh` |
| Review before publish | ✅ | Whole-snapshot gate + agent trail |
| Per-hunk approval | ❌ | Backlog |
| Amend / stacked PR / base selection | ❌ | Backlog |
| MCP manager | ✅ | Project scope + sealed env |
| Hooks | ✅ | `.chathub/hooks` |
| Board | ✅ | `.chathub/board.json`, per-item merge |
| Spec-driven planning | ❌ | Backlog |
| Parallel task waves | ❌ | Backlog |
| Custom subagents | ❌ | Backlog |
| AGENTS.md / CLAUDE.md editor | ❌ | Backlog |
| Skills / slash commands | ❌ | Backlog |
| Usage dashboard | ❌ | Backlog; raw usage already persisted |
| Auto model routing | ❌ | Backlog |
| Mobile / remote PWA | ❌ | Separate platform track |
| Windows / Linux | ❌ | Separate platform track |

## Backlog для агентов

Задачи ниже намеренно не реализованы. Каждую брать в отдельный worktree и закрывать PR-ом с
тестами, typecheck, полным Vitest и build.

### P1 — Git

- Amend последнего commit с confirmation после push.
- Выбор PR base branch и stacked PR между session branches.
- Per-hunk review decisions поверх текущего publish gate.
- Опциональный AI-generated PR title/body; deterministic fallback оставить.
- Guided export/backup dirty worktree перед ручным удалением.

### P2 — Контекст

- Редактор `AGENTS.md`/`CLAUDE.md` и preview того, что уйдёт в prompt.
- Project skills/slash-command discovery и вставка в composer.
- Перенос sidebar archive из localStorage в `SessionMeta`.

### P3 — Kiro-подобная оркестрация

- Spec mode: requirements → design → tasks, сохранение в `.chathub/specs/<slug>/` и линковка
  с Board.
- Dependency graph и task waves в независимых worktrees.
- Named subagent presets и MAGI-подобное сравнение двух независимых прогонов.
- Auto-routing по сложности с ручным override.
- Usage dashboard по дням/проектам/провайдерам/моделям/effort.

### P4 — Платформа

- Auto-update для signed/notarized distribution.
- Windows/Linux, headless CI и local HTTP/WS + PWA.

## Как читать старые планы

Старые roadmap-чеклисты могли помечать уже закрытые пункты (`resolvePermission`, signing,
archive, worktrees, MCP, hooks, attachments) как незавершённые. Источником истины теперь являются
этот файл и [roadmap-v2.md](./roadmap-v2.md), проверенные относительно `origin/main`.

## Источники сравнения

[Kiro](https://kiro.dev/), [T3 Code](https://t3.codes/), [T3 Code GitHub](https://github.com/pingdotgg/t3code),
[Panes](https://panesade.com/), [Panes GitHub](https://github.com/wygoralves/panes),
[ADHDev](https://github.com/vilmire/adhdev).
