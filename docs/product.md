# Chat Hub — Product

## Problem

T3-like UIs:

- sticky «Working» without real agent
- weak multi-chat management
- single-provider lock-in
- hard to follow many parallel sessions

## Goals

1. **Multi-chat first** — N sessions, clear active list
2. **Multi-provider** — Grok Build, Claude Code, Codex, OpenCode via adapters
3. **Honest status** — running / waiting_input / idle / error from events
4. **Emit to Monitor** — optional local bridge for tray/notifs
5. **Project-aware** — cwd / worktree / title per session

## Core flows

### F1 — New session
Pick provider + project folder → create session tab.

### F2 — Chat
User messages → agent tools/stream → transcript UI.

### F3 — Parallel work
Several tabs; sidebar shows status dots; filter waiting_input.

### F4 — Needs attention
Highlight + optional push to Session Monitor + OS notif (if Monitor not installed, Hub can notif itself).

## Non-goals (v0–v1)

- Built-in model training / fine-tune
- Mobile app
- Perfect parity with every CLI flag day one

## Success metrics

- 4+ concurrent sessions usable
- Status never stuck when process dies
- Switch provider without rewriting UI
