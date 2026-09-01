# Implement durable Supervisor state core

Type: task
Status: resolved
Blocked by: 07

## Question

Implement SQLite persistence, transactional Work Item transitions, transition history, Supervisor Lease fencing, durable launch identities, recovery reconciliation interfaces, and deterministic in-memory test adapters.

## Answer

`AutopilotStore` is the public persistence seam, with memory and SQLite adapters sharing one transactional mutation model.

Implemented:

- One active Autopilot Run per canonical root
- SQLite at a caller-provided path with owner-only `0600` permissions, WAL, and a partial unique index for the active root
- Fenced Supervisor Leases, stale-token rejection, and owner renew
- Validated Work Item and run transitions with append-only history
- Durable Worker Attempt launch tokens before session attach
- Worktree reservation collision checks
- Evidence-based `reconcileObservedAttempts` that attaches observed sessions or marks missing work unknown
- Successor Work Items for changed completed source keys
- Deterministic clock injection and in-memory adapter for tests

Verification: `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`.
