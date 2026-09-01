# Decide Worker isolation, integration, and concurrency

Type: grilling
Status: resolved
Blocked by: 02, 03, 04

## Question

How should the Supervisor create and reconcile Worker sessions and git worktrees, prevent duplicate or conflicting Work Items, detect completion or disappearance, and automatically integrate verified commits without corrupting concurrent work?

## Answer

Reserve one deterministic branch and worktree per Work Item, reused across repair attempts.
Create a fresh OpenCode session for every Worker Attempt.
Persist reservations before filesystem or session creation and reconcile both from durable identities after restart.

Dependencies always gate scheduling.
Serialize Work Items with known overlapping file scopes, while unknown overlap may run concurrently because worktrees isolate writes.
Use configurable concurrency with four active Workers by default, plus a separate one-at-a-time Integration Lane.
Non-Git file-changing work remains concurrency one as previously decided.

Create a dedicated Run Branch and integration worktree from the selected starting revision.
Workers branch from the current Run Branch head at scheduling time.
Require Worker-produced commits and identify the exact commit range from each reserved base.
Verify work inside its worktree, then cherry-pick that range under the Integration Lane onto current Run Branch head.
Never mutate the user's checked-out branch by default; an explicit objective or configuration may target it only when clean and guarded.

If integration conflicts, abort without changing the Run Branch, record conflict evidence, and create a contextual repair/rebase attempt in the same Work Item worktree.
Re-run verification before another integration attempt.
Never let Supervisor invent a commit from unexplained uncommitted changes.

Extract existing `dynamic-task.ts` child-session behavior behind a shared `SessionRunner` interface.
Preserve the `task` tool through its own adapter while Autopilot uses the same runner directly with durable launch identity and reconciliation around it.
Supervisor does not depend on tool-calling-tool or synthetic parent notifications.

Treat `session.idle` or an explicit result as candidate completion, never proof of success.
Session errors, disappearance, stale events, and aborts become observed lifecycle evidence reconciled through fenced state transitions.
Remove successfully integrated worktrees only after commit evidence is durable.
Preserve failed, stuck, aborted, conflicted, force-stopped, or dirty worktrees until explicit cleanup.

Architectural rationale: [Isolate Workers and serialize verified integration](../../../docs/adr/0004-isolated-workers-serialized-integration.md).
