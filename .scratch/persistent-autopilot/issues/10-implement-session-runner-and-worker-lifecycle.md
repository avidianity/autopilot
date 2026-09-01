# Implement SessionRunner and Worker lifecycle

Type: task
Status: resolved
Blocked by: 07, 08

## Question

Extract and reuse existing dynamic-task child-session behavior behind SessionRunner, then implement durable Worker launch, event reconciliation, cancellation, worktree reservation, concurrency gates, and restart-safe lifecycle handling.

## Answer

Worker launch goes through `SessionRunner` plus `WorkerLifecycle`.

Implemented:

- `SessionRunner` with OpenCode and fake adapters, no parent-tool notification dependency
- Launch titles encoding run, Work Item, and launch token
- Persist worktree reservation and Worker Attempt before session create
- Concurrency, dependency, and overlapping file-scope gates
- Idle as verifying, not completed
- Abort and restart recovery from session titles

Verification: `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`.
