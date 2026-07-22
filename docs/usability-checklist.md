# Chat Hub — чеклист полной работоспособности

Цель: **ежедневный multi-agent workbench** вместо отдельных TUI (Claude Code, Codex, Grok Build, OpenCode).  
UI shell (sidebar / transcript / composer) — база. Дальше — **реальные процессы и T3-подобные actions**.

Легенда: ✅ есть · 🟡 частично / mock · ❌ нет

---

## 0. Что есть сейчас (honest status)

| Область | Статус |
|---------|--------|
| Electron + React shell | ✅ |
| Multi-project sidebar + sessions | ✅ (demo + create) |
| Chat transcript + streaming UI | ✅ (mock stream) |
| Status event bus (не «stuck Working» без process) | 🟡 mock ok; real process — нет |
| Persist sessions/messages | ✅ |
| OS notifications | ✅ |
| Bridge → Session Monitor (JSONL) | ✅ |
| **Реальный agent (Claude/Codex/Grok/OpenCode)** | ❌ только `mock` |
| Open / Commit / Add action / folder picker | ❌ UI-заглушки |
| Tools / diffs / permissions UI | ❌ |
| Worktree / local checkout real | ❌ label only |

**Вывод:** это **cockpit UI + mock agent**. Чтобы «юзать вместо codex/claude» — закрыть фазы A→D ниже.

---

## A. Один реальный agent loop (P0 — «можно работать»)

Без этого приложение остаётся демо.

### A1. Process adapter foundation
- [ ] `AgentAdapter` с **живым process handle** (pid, stdin/stdout/stderr, kill tree)
- [ ] `start` = spawn CLI в `cwd`, не mock timer
- [ ] `send` = message в session (stdin / headless API / resume flag)
- [ ] `abort` = SIGTERM/SIGKILL + status `idle`/`error`
- [ ] exit/crash → **никогда** не оставлять `running` (exit code → `done`/`error`)
- [ ] non-blocking send (IPC не ждёт весь stream)
- [ ] parse stdout/events → `chat.delta` + `session.status` + `session.message`

### A2. Первый провайдер (выбрать **один** daily driver)
Рекомендация: тот, кем пользуешься каждый день.

| Provider | Подход (T3-like) | Критерий «done» |
|----------|------------------|-----------------|
| [ ] **Claude Code** | `claude` CLI headless / print / session resume; hooks | prompt → tools → reply, multi-turn |
| [ ] **Codex CLI** | `codex` exec/resume | то же |
| [ ] **Grok Build** | Grok CLI / headless | то же + later subagents |
| [ ] **OpenCode** | opencode CLI/events | то же |

- [ ] Binary discovery (`which`, settings path, version check)
- [ ] Provider `available: true` только если binary найден
- [ ] Понятные ошибки: «Claude not installed», «auth required»

### A3. Project = real folder (как T3 local checkout)
- [ ] **Folder picker** при New session / New in project
- [ ] `cwd` = realpath, persist per session
- [ ] Sidebar project name = basename(cwd) (не hardcode `/Users/dev/projects/...`)
- [ ] Allowlist / refuse spawn вне выбран (security)
- [ ] Footer **Local checkout** = real branch (`git rev-parse`) + dirty indicator

### A4. Session lifecycle как у T3
- [ ] Create session → spawn agent in project
- [ ] Re-open app → sessions list restored; **не** auto-running
- [ ] Resume session if provider supports (session id / transcript path)
- [ ] Delete session → kill process + optional archive
- [ ] Parallel sessions (2–4+) без UI freezes

**Definition of Done A:** один провайдер, реальный folder, multi-turn chat, abort, status honest, restart-safe.

---

## B. T3-like workbench actions (P1 — «удобно как T3»)

Кнопки в top bar / composer сейчас disabled — это must для daily use.

### B1. Top bar
- [ ] **Open** → open `cwd` in Finder / VS Code / Terminal (picker)
- [ ] **Commit** → git status short + stage/commit dialog (or shell out to `git`)
- [ ] **Add action** → menu: New session same project, Run command, Open PR URL, Diff
- [ ] Bookmark / pin session (optional)
- [ ] Stop всегда когда `running`

### B2. Composer (как T3 model row)
- [ ] Model / mode selectors **wired** to provider flags (не decorative chips)
- [ ] Permission mode: read-only / full access / ask (map to CLI flags)
- [ ] Attach images/files → pass to provider if supported
- [ ] Slash commands: `/clear`, `/compact`, `/cost`, `/model` (provider-dependent)
- [ ] Queued message while Working (optional, T3-like)

### B3. Sidebar power
- [ ] Filter: Waiting / Working / All
- [ ] Search works across title + last message preview
- [ ] Drag session between projects? (or change cwd) — later
- [ ] Hide demo seed in prod; empty state CTA «Open project…»
- [ ] Context menu: rename, archive, reveal in Finder, copy path

### B4. Transcript density (T3 parity)
- [ ] Tool call cards (command, path, exit code) — parse from provider events
- [ ] Diff / file change blocks (open file on click)
- [ ] Permission / question prompts inline (Approve / Deny)
- [ ] Copy message / copy code
- [ ] Collapse long tool output
- [ ] Timestamps + token/cost footer if API gives them

**Definition of Done B:** Open/Commit/Stop real; tools visible; approve flow for dangerous ops.

---

## C. Multi-provider + multi-project (P1–P2 — «вместо всех CLI»)

### C1. Second / third adapters
- [ ] Adapter #2 after A stable (same interface)
- [ ] Adapter #3–4 (Claude + Codex + Grok/OpenCode)
- [ ] Per-session provider (already in meta) + switch only on new session
- [ ] Settings UI: path to each CLI, default model, env

### C2. Auth & secrets
- [ ] Secrets **only main / keychain** (never renderer)
- [ ] Detect unauthenticated CLI → deep link / instructions
- [ ] No API keys in JSONL bridge

### C3. Subagents / parallel (Grok / T3 later)
- [ ] Child sessions in sidebar under parent
- [ ] Fan-out status dots
- [ ] Bridge events for children → Monitor

### C4. Worktrees (product.md project-aware)
- [ ] Create git worktree per session (optional toggle)
- [ ] Cleanup worktree on delete

**Definition of Done C:** ≥2 real providers; auth ok; projects = real repos.

---

## D. Reliability & polish (P1 — «можно доверять»)

- [ ] `before-quit` await flush
- [ ] Process watchdog: if pid dead → force status
- [ ] Large transcript: JSONL per session or SQLite (not one giant state.json forever)
- [ ] Bridge JSONL rotate/cap
- [ ] Dedupe notifications Hub vs Monitor
- [ ] Crash recovery: no stuck Working after force-quit
- [ ] Logging panel (main) for adapter debug
- [ ] Auto-update / packaged `.app` (electron-builder) — macOS first
- [ ] Basic e2e: create → send → status transitions

---

## E. Session Monitor integration (optional but strong)

- [ ] Monitor shows **real** Hub sessions (already tails JSONL)
- [ ] Click session in Monitor → focus Hub window / session
- [ ] Badge = waiting_input across all providers
- [ ] Suppress Hub OS notif if Monitor is running (optional)

---

## F. Explicitly NOT required for v1 daily driver

- Perfect parity with every CLI flag
- Cloud multiplayer
- Built-in model training
- Notch-only UI (that’s Session Monitor)
- All 4 providers day one (start with 1)

---

## Порядок внедрения (рекомендуемый sprint plan)

```
Week 1 — Phase A (one real agent)
  A1 process adapter skeleton
  A2 Claude Code OR Codex OR Grok (pick one)
  A3 folder picker + real cwd
  A4 multi-turn + abort + restart-safe status

Week 2 — Phase B (T3 actions)
  B1 Open / Commit / Stop
  B2 composer flags wired
  B4 tool cards + permission approve

Week 3 — Phase C/D
  second provider
  packaging + reliability
  Monitor deep-link
```

### Критерий «я могу выкинуть отдельный Claude/Codex TUI»
1. Открыл repo с диска  
2. Написал задачу агенту  
3. Видишь tools/diff  
4. Approve когда надо  
5. Commit из top bar  
6. 2+ sessions параллельно  
7. Status никогда не врёт  
8. После reboot история и projects на месте  

---

## Быстрый map: UI button → backend need

| UI (сейчас) | Чтобы заработало |
|-------------|------------------|
| Agent Mock only | Real adapter + binary |
| + New / New in project | `dialog.showOpenDialog` → cwd |
| Send | provider `send` + stream parse |
| Stop | `abort` kill process |
| Open ▾ | shell open path / `code` / Terminal |
| Commit ▾ | git status + commit IPC |
| Add action | command palette actions |
| High/Normal, Full access | CLI flags on spawn |
| Build / Tasks | provider-specific modes or hide until real |
| Local checkout | `git` in session cwd |
| Attach images | multipart / path inject to CLI |
| Working pill | process-linked status events only |

---

## Решение «с кого начать адаптер»

Ответь одним (и следующий PR — только он):

1. **Claude Code** — самый частый daily  
2. **Codex CLI** — если основной workflow OpenAI  
3. **Grok Build** — native xAI / suite story  
4. **OpenCode** — если уже на opencode events  

После выбора Phase A режется в implementable PR plan (spawn → stream → status → folder picker).
