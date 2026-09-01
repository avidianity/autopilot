# Verify Autopilot end to end

Type: task
Status: resolved
Blocked by: 12, 13

## Question

Exercise real OpenCode plugin behavior and deterministic test doubles across startup, objective persistence, discovery, dependencies, concurrency, duplicate prevention, Worker completion and disappearance, retries, stuck isolation, pause/resume, graceful and force stop, healthy idle, restart recovery, and worktree collisions.

## Answer

Covered with deterministic doubles in `test/store.test.ts`, `test/planning.test.ts`, `test/workers.test.ts`, `test/verify.test.ts`, `test/supervisor.test.ts`, and `test/plugin.test.ts`. Live OpenCode process exercise still requires a local restart after plugin install.

Final gates: `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`.
