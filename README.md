# Chat Hub

> Multi-chat cockpit for AI coding agents (Grok, Claude Code, Codex, OpenCode).

Electron (macOS first) · TypeScript · React

## What it is

Полноценный **chat shell** (лучше T3):

- много чатов / сессий параллельно
- tabs + sidebar
- adapters на несколько провайдеров
- надёжные статусы сессий (event bus, не stuck «Working»)
- эмит событий в **Session Monitor** (optional bridge)

## What it is not

- Не ambient notch-only app (это Session Monitor)
- Не cloud multiplayer IDE
- Не единый «свой» LLM runtime — wrap existing CLIs/APIs

## Docs

- [Product](./docs/product.md)
- [Architecture](./docs/architecture.md)
- [MVP checklist](./docs/mvp.md)
- [Providers](./docs/providers.md)

## Stack (planned)

- Electron
- React + TypeScript
- node-pty where needed
- Provider adapters (pluggable)

## Status

Docs + empty git repo. App scaffold next.
