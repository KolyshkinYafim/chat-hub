# History and Git-flow sprint

This sprint keeps the renderer fast while making long-running, parallel agent
work recoverable and reviewable.

## Implemented

- `state.json` keeps only the newest 200 messages per session.
- Overflow messages are appended to
  `data/sessions/<session-id>/archive.jsonl`; the archive is read lazily when
  the renderer scrolls above the in-memory tail.
- The renderer requests older pages when the transcript reaches the top, and
  restores scroll position after prepending them.
- New sessions can opt into an isolated `~/.chathub/worktrees/<project>/…`
  directory and a `chathub/<slug>-<id>` branch. The default stays off for
  non-Git folders; enabling it starts from the current `HEAD`.
- Session deletion removes a clean isolated worktree; a dirty worktree is
  preserved and reported in the main-process log instead of being discarded.
- Source Control exposes explicit `Push` and `Create PR` actions. Push uses
  `git push --set-upstream origin HEAD`; PR creation uses `gh pr create` with
  argument arrays, never shell interpolation.
- Push and PR actions require an explicit review confirmation after inspecting
  the current file list and diff. An empty PR body is filled from recent
  commits, the latest diff stat, and working-tree status.
- Source Control lists all repository worktrees, marks dirty/stale entries, and
  only removes clean managed checkouts; stale Git metadata can be pruned
  explicitly.

## Verification

- Full Vitest suite, TypeScript checks, and the production Electron build are
  run as merge gates (the exact count is reported by CI for the current main).
- Node and web TypeScript checks pass.
- Production Electron build passes.
- Dedicated tests cover transcript migration/tail paging, path traversal
  rejection, and creation/removal of an isolated Git worktree.

## Deliberate follow-ups

- Add a guided export/backup flow for dirty worktrees before manual removal.
