# Implement verification, repair, and integration

Type: task
Status: resolved
Blocked by: 08, 09, 10

## Question

Implement Verification Plans, constrained deterministic checks, semantic acceptance, baseline comparison, contextual repairs, retry and stuck handling, Run Branch integration, conflict recovery, and evidence-safe worktree cleanup.

## Answer

VerificationEngine owns immutable Verification Plans, constrained process checks, baseline comparison, semantic acceptance that cannot waive deterministic failure, cherry-pick integration, conflict revert, repair prompts, and stuck isolation after three implementation failures.

Tests: `test/verify.test.ts`.
