# Chat Hub — Roadmap v2 (daily driver)

Честный статус после Phase A (реальные CLI) + UI workbench.  
Цель: **можно жить в Hub** вместо T3 / отдельных Claude/Codex/Grok TUI.

Легенда: ✅ есть · 🟡 частично · ❌ нет

---

## 0. Прямые ответы на «где аккаунты?» и «как модели?»

### Сейчас

| Вопрос | Ответ |
|--------|--------|
| **Где подрубать аккаунты?** | **Нигде в Hub.** Auth идёт через **CLI**, которые уже на машине: `claude` login / Anthropic key, `grok` auth, `opencode auth`, `codex login`. Hub только spawn’ит binary. |
| **Как выбирать модели?** | **Никак в UI.** Идут **default модели CLI**. Нет model picker, нет per-session model. |

### Как должно быть (T3-класс)

```
Settings (⌘,)
├── Providers
│   ├── Claude Code   [Connected ●]  [Login…] [Path…] [Default model ▾]
│   ├── Grok Build    [Connected ●]  [Login…] [Path…] [Default model ▾]
│   ├── OpenCode      [… list from opencode models]
│   └── Codex         […]
├── Appearance / Permissions default (YOLO)
└── Advanced (bridge path, demo seed)
```

Composer (как T3):

```
[✦ Claude Code ▾]  [Sonnet 4 ▾]  [YOLO ▾]  [High ▾]     (↑)
```

Session store: `provider` + `model` + `permissionMode` per session.

---

## 1. Honest gap map (что реально недоделано)

| Область | Статус | Боль |
|---------|--------|------|
| Shell UI (sidebar, transcript, composer look) | ✅ | — |
| Real CLI spawn (claude/grok/opencode) | 🟡 | stream parse грубый; resume хрупкий |
| **Accounts / login UI** | 🟡 | Settings → Providers: status + Login… |
| **Model picker** | 🟡 | composer chip + default in Settings |
| Settings window | ✅ | ⚙ / ⌘, Providers + General |
| Binary path override | ❌ | только PATH discover |
| Auth health check | ❌ | ошибка только после failed run |
| Effort / thinking / mode chips | 🟡 | decorative / partial |
| Tool cards + diffs in transcript | ❌ | сырой текст + 🔧 name |
| Permission approve UI (when not YOLO) | ❌ | CLI alone |
| Attach images/files | ❌ | placeholder text |
| Add action / Open menu polish | 🟡 | Open/Commit есть, Add action нет |
| Worktrees | ❌ | |
| Parallel session process isolation | 🟡 | one turn/process per send |
| Packaging .app | ❌ | `pnpm dev` only |
| Onboarding first-run | ❌ | empty state weak |
| Session rename / archive | ❌ | |
| Search real (last message) | 🟡 | title only |
| Cost / tokens footer | ❌ | |
| Jump from Session Monitor → Hub session | ❌ | |

---

## 2. Plan P0 — «я понимаю, чем работаю» (Accounts + Models)

**Срок-ориентир:** 1 итерация, без нового провайдера.

### P0.1 Settings shell
- [ ] Окно **Settings** (`⌘,` / gear в sidebar)
- [ ] Tabs: **Providers** · **General** · **Advanced**
- [ ] Persist: `userData/data/settings.json` (расширить текущий store)

### P0.2 Accounts / provider status
Для каждого провайдера карточка:

| Field | Source |
|-------|--------|
| Installed | `findBinary` + version (`claude -v`) |
| Path | auto + override text field |
| Auth status | probe (см. ниже) |
| Actions | Login / Open docs / Re-detect |

**Auth probes (main only, never secrets in renderer):**

| Provider | Probe |
|----------|--------|
| Claude | `claude -p "hi" --output-format json` dry? or check `~/.claude` / auth status command if any; surface stderr «not logged in» |
| Grok | `grok --version` + known config path |
| OpenCode | `opencode auth list` / `opencode providers` |
| Codex | `codex login` status if available |

- [ ] UI: green **Connected** / amber **Needs login** / red **Not installed**
- [ ] Button **Login…** → spawn interactive terminal OR open CLI login (`Terminal.app` with command) / `shell.openPath` to docs
- [ ] Never store API keys in renderer; optional keychain later for raw API path

### P0.3 Model catalog + picker
- [ ] Per-provider `listModels(): Promise<ModelInfo[]>`
  - Claude: static curated list + optional `claude` models API if exists; else known IDs (`sonnet`, `opus`, `haiku` aliases)
  - Grok: `grok` model list / curated
  - OpenCode: `opencode models` parse
  - Codex: curated
- [ ] Settings: **Default model** per provider
- [ ] Composer: **model chip** (enabled when provider has models)
- [ ] `SessionMeta.model: string`
- [ ] Adapter spawn passes `--model <id>` (claude/grok/opencode already support)

### P0.4 Wire send path
```
createSession({ provider, cwd, model? })
sendMessage → adapter.send(..., { permissionMode, model })
```
- [ ] Resume keeps same model unless user changes mid-session (optional lock)

**DoD P0:**  
Settings → вижу Claude Connected, выбираю Sonnet, new session, send uses that model.  
Не connected → понятная кнопка Login, не «молча упало».

---

## 3. Plan P1 — «как T3 composer» (session controls)

### P1.1 Composer row (real, not decorative)
| Chip | Behavior |
|------|----------|
| Provider | already |
| **Model** | P0.3 |
| Permission | YOLO/Edits/Ask already |
| **Effort** | map to Claude `--effort`, Grok equivalents |
| Attach | file dialog → CLI `--file` / path inject |

### P1.2 New session dialog (T3-like)
Instead of silent folder pick only:
```
New session
  Project: [Browse…]  ~/code/mary
  Agent:   [Claude ▾]
  Model:   [Sonnet ▾]
  Mode:    [YOLO ▾]
  [Create]
```

### P1.3 Session header
- Show model + provider under title
- Change model for **next** message (or restart session)

### P1.4 Transcript upgrades
- [ ] Tool call cards (name, short args, exit)
- [ ] Collapsible long blocks
- [ ] Copy button on code
- [ ] System line: «Using claude · sonnet · yolo · /path»

**DoD P1:** composer = real control surface; new session always chooses project+model.

---

## 4. Plan P2 — reliability & polish

### P2.1 Adapter hardening
- [ ] Golden fixtures for stream-json lines (claude/grok/opencode)
- [ ] Better resume / session id persistence on SessionMeta
- [ ] Concurrent sessions stress (4+)
- [ ] Stuck-running watchdog (pid dead → idle/error)

### P2.2 Product
- [ ] Rename session, archive
- [ ] Filter Waiting/Working
- [ ] First-run wizard: detect CLIs → login → pick model → open folder
- [ ] Jump from Session Monitor → focus Hub + session id (commands.jsonl)

### P2.3 Ship
- [ ] `electron-builder` macOS .app
- [ ] Auto PATH fix for GUI (already partial Homebrew)
- [ ] Crash reports / debug log viewer in Settings → Advanced

**DoD P2:** cold start → wizard → working chat without terminal knowledge.

---

## 5. UI placements (куда что класть)

```
┌─ Sidebar ─────────────────┐  ┌─ Main ────────────────────────────┐
│ Chat Hub          [⚙]     │  │ Title · model · YOLO              │
│ Search                    │  │ [Open] [Commit]                   │
│ Projects…                 │  │ transcript…                       │
│                           │  │ ┌ composer ─────────────────────┐ │
│ Agent: Claude             │  │ │ message…                      │ │
│ (status: Connected)       │  │ │ [Claude▾][Sonnet▾][YOLO▾][↑]  │ │
└───────────────────────────┘  │ └───────────────────────────────┘ │
                               └───────────────────────────────────┘

Settings (modal or route)
  Providers | General | Advanced
```

- **Accounts** → Settings → Providers (не composer)  
- **Model** → composer chip + session default from Settings  
- **YOLO** stays composer (session/global)

---

## 6. Implementation order (PR stack)

| PR | Scope | User-visible |
|----|--------|--------------|
| **PR1** | Settings window + provider cards + path/version detect | «где аккаунты» |
| **PR2** | Auth status + Login action (CLI/Terminal) | Connected / Needs login |
| **PR3** | Model list + picker + `--model` in adapters | «как модели» |
| **PR4** | New session dialog (folder + provider + model) | T3 create flow |
| **PR5** | Effort/attach + system banner in transcript | denser workbench |
| **PR6** | Tool cards + stream fixtures | readable agent work |
| **PR7** | First-run wizard + packaging | install & go |

---

## 7. Out of scope (не сейчас)

- Свой LLM backend вместо CLI  
- Cloud multiplayer  
- Perfect parity every CLI flag  
- Replacing Session Monitor Swift island in Hub  
- Training / fine-tune  

---

## 8. Success criteria (когда «норм планы» закрыты)

1. Открыл Settings → видишь свои провайдеры и login state.  
2. Выбрал модель в composer → следующий turn идёт с `--model`.  
3. New session = folder + agent + model, без магии.  
4. Не залогинен → явная ошибка + Login, не silent fail.  
5. 2+ sessions, YOLO default, Open/Commit, Monitor bridge — как сейчас, но понятнее.

---

## 9. Workaround сегодня (пока PR1–3 нет)

| Нужно | Как сейчас |
|-------|------------|
| Claude account | В Terminal: `claude` → login / Anthropic subscription |
| Grok account | Grok Build CLI auth (как обычно в TUI) |
| OpenCode | `opencode auth` / `opencode providers` |
| Model | defaults CLI; или env/config **самого** CLI (`~/.claude`, grok config) |
| YOLO | chip в composer (уже есть) |

Hub **не** хранит и не показывает эти аккаунты — только вызывает binary.
