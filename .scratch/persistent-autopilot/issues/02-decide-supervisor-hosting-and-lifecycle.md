# Decide Supervisor hosting and lifecycle

Type: grilling
Status: resolved
Blocked by: 01

## Question

Given the supported OpenCode extension contracts, where should the deterministic Supervisor run, how should command handlers communicate with it, and what lifecycle guarantees can it provide across idle periods, OpenCode restarts, graceful stop, and force stop?

## Answer

Run one plugin-resident Supervisor per canonical repository root, falling back to the OpenCode project directory when Git metadata is unavailable.
Reject a second enabled Autopilot Run for the same root and report the existing objective.

Expose one deterministic model-callable control tool behind thin `/autopilot` command templates.
The control interface validates and applies `start`, `status`, `pause`, `resume`, `stop`, and `stop --force`; conversation state is never authoritative.

Pause stops new scheduling but lets active Workers complete verification.
Graceful stop persists stop intent, stops scheduling, drains active Workers, then marks the run stopped.
Force stop persists intent first, aborts active sessions, preserves recoverable worktrees, and marks the run stopped after reconciliation.

After process restart, reconcile durable records against actual sessions before any transition.
Default to a Recovery Hold that requires explicit `/autopilot resume`; support configurable `autoResumeAfterRestart` for unattended continuation.
Paused runs remain paused, and interrupted stop transitions complete without scheduling.

Permit non-Git projects in degraded mode.
Force file-changing Work Items to concurrency one, disable automatic commit/integration, and expose degraded isolation in status; read-only discovery and verification may still run concurrently.

Architectural rationale: [Keep the Supervisor inside the OpenCode plugin](../../../docs/adr/0001-plugin-resident-supervisor.md).
