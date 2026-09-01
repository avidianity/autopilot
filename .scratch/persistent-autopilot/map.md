## Destination

This repository contains an installable, documented, and verified OpenCode autopilot plugin whose deterministic Supervisor persistently discovers, schedules, verifies, and integrates isolated Worker output until explicitly stopped.

## Notes

This effort carries execution through implementation, tests, and concise documentation; it does not stop at a specification.
Consult `customize-opencode`, `codebase-design`, `domain-modeling`, and `tdd` as relevant in each session.
Use terms from `CONTEXT.md`.
The plugin must be reusable across OpenCode-supported environments but validated against the locally installed version first.
Verified integration is configurable and automatic by default.
Remote mutations require an Autopilot Objective that explicitly requests them.
An empty work queue means idle rediscovery with bounded backoff, never implicit termination.

## Decisions so far

- [Research installed OpenCode extension contracts](issues/01-research-opencode-extension-contracts.md): use legacy plugin hooks and the existing session runner, with durable reconciliation, runtime Capability discovery, Git gating, and version probes; [full research](../../docs/research/opencode-extension-contracts.md).
- [Decide Supervisor hosting and lifecycle](issues/02-decide-supervisor-hosting-and-lifecycle.md): one plugin-resident Supervisor owns each project, controlled through deterministic tools, with safe pause/stop semantics, configurable restart recovery, and degraded non-Git operation.
- [Define durable state and recovery ownership](issues/03-define-durable-state-and-recovery-ownership.md): SQLite transactions, fenced Supervisor Leases, durable Worker launch identities, evidence-based reconciliation, and fail-closed recovery make restarts duplicate-safe.
- [Define discovery, planning, and Capability contracts](issues/04-define-discovery-planning-and-capability-contracts.md): selected Work Sources emit immutable evidence, a schema-constrained Semantic Engine proposes plans and instructions, and deterministic code validates every transition against reproducible Capability snapshots.
- [Decide Worker isolation, integration, and concurrency](issues/05-decide-worker-isolation-integration-and-concurrency.md): reusable Work Item worktrees and fresh Worker Attempts run concurrently, while verified commits enter a dedicated Run Branch through one serialized Integration Lane.
- [Define verification, repair, and completion state machine](issues/06-define-verification-repair-and-completion-state-machine.md): immutable Verification Plans and persisted evidence control completion, with baseline-aware checks, constrained execution, bounded repair, stuck isolation, and healthy idle rediscovery.
- [Establish repository, package, and test foundation](issues/07-establish-repository-package-and-test-foundation.md): initialized Git and a pinned Bun/TypeScript OpenCode plugin package with strict test, typecheck, lint, and build gates.
- [Implement durable Supervisor state core](issues/08-implement-durable-supervisor-state-core.md): AutopilotStore persists runs, fenced leases, Work Item transitions, launch identities, and observed-session reconciliation in SQLite and memory.
- [Implement discovery, planning, and Capability core](issues/09-implement-discovery-planning-and-capability-core.md): selected Work Sources emit evidence, a schema-constrained Semantic Engine proposes plans and instructions, and deterministic code applies and compiles them.
- [Implement SessionRunner and Worker lifecycle](issues/10-implement-session-runner-and-worker-lifecycle.md): durable launch identities, worktree reservations, concurrency gates, idle-as-verifying, abort, and title-based recovery.

## Not yet specified

- Performance limits, observability details, and hardening exposed by the first working end-to-end loop.

## Out of scope

- A hosted control plane or service independent of OpenCode.
- First-party work-source adapters beyond direct objectives, GitHub issues, repository checks, plans, Markdown tasks, explicit files, and TODOs.
- A graphical management interface beyond OpenCode commands and concise status output.
