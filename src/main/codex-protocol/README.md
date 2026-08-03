# Codex app-server protocol

`generated/` contains the TypeScript protocol bindings emitted by the installed
Codex CLI. Regenerate them after a Codex CLI upgrade with:

```sh
pnpm generate:codex-protocol
```

`client.ts` is Chat Hub's long-lived JSONL/JSON-RPC transport. Keep application
state and UI mapping in the Codex adapter rather than editing generated files.
