# Define durable state and recovery ownership

Type: grilling
Status: resolved
Blocked by: 02

## Question

What durable state model, locking protocol, and recovery reconciliation rules let one Supervisor safely resume an Autopilot Run without duplicate Workers, lost completions, worktree collisions, or conflicting command processes?

## Answer

Store durable state in SQLite at `<canonical-root>/.opencode/autopilot/state.sqlite`, with owner-only permissions and Git exclusion.
Hide persistence behind one small storage interface with an in-memory adapter for deterministic tests.

Maintain normalized current-state tables and append-only transition records in the same transaction.
Database state expresses intent; OpenCode sessions, Git, worktrees, and filesystem state provide observed evidence.
Reconciliation advances state only through explicit idempotent rules, and ambiguous evidence yields an `unknown` or repair state rather than assumed completion or duplicate launch.

One OpenCode process acquires a renewable Supervisor Lease using a transactional, monotonically increasing fencing token.
Every mutating transaction verifies that token.
An instance that loses ownership immediately stops scheduling and writes, ignores lifecycle events under the stale token, and leaves Workers untouched for the new owner to reconcile.

Persist each Worker Attempt and unique launch token before creating its session.
Embed run, Work Item, attempt, and launch identity in the child-session title, then attach the returned session ID transactionally.
Startup reconciliation searches sessions for unresolved launch identities before creating another Worker.
Reserve deterministic worktree identities transactionally before filesystem creation.

Keep stopped runs and diagnostics under configurable retention, but never automatically delete active records or worktrees.
If the database is unreadable or corrupt, fail closed, preserve it, expose recovery diagnostics, and schedule nothing.
Retain objectives and Worker Instructions as control data, redact them from routine logs/status where needed, and never persist discovered credentials or environment secrets.

Architectural rationale: [Persist state in SQLite with fenced ownership](../../../docs/adr/0002-sqlite-state-with-fenced-ownership.md).
