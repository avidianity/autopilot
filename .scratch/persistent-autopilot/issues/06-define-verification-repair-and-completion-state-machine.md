# Define verification, repair, and completion state machine

Type: grilling
Status: resolved
Blocked by: 03, 04, 05

## Question

What task-aware verification evidence, state transitions, repair instructions, retry rules, stuck isolation, and idle rediscovery semantics are required so Worker claims never determine Supervisor completion?

## Answer

Derive and persist an immutable Verification Plan before Worker launch from Work Item, Discovery Evidence, repository checks, and Autopilot Objective.
Workers receive but cannot weaken it; verifier may add safety checks but cannot remove requirements.
Capture baseline repository evidence at run start and fail unrelated work only for new or worsened defects unless objective requires whole-repository health.

Run targeted deterministic checks in Work Item worktree, then semantic acceptance where criteria require it.
After cherry-pick, run affected integration checks on Run Branch.
On integration-check failure, revert cleanly, persist evidence, and issue repair.
Required deterministic failures cannot be waived by semantic acceptance.

Persist exact verification command, directory, timeout, environment allowlist, expected result, and bounded redacted output.
Execute through constrained process adapter in designated worktree.
Remote mutation, credential discovery, and destructive commands require explicit authorization in Autopilot Objective.

Use validated transactional Work Item states: `pending`, `blocked`, `ready`, `launching`, `running`, `verifying`, `integrating`, `completed`, `repairing`, `stuck`, `superseded`, `cancelled`, and `unknown`.
Worker Attempt failures are records, not terminal Work Item failure.
A Work Item completes only after required evidence passes and its commit range is durably integrated; non-Git mode requires passing evidence plus recorded before/after filesystem snapshot.

Implementation or acceptance failures consume three Worker Attempts by default.
Repair stays on same Work Item and includes exact failed checks, relevant diff, prior session/commit evidence, and required rerun.
Create linked successor work only for independently actionable findings outside original scope.
Transient infrastructure failures use bounded exponential backoff without consuming implementation attempts; persistent infrastructure failure blocks with diagnostics.
Stuck dependencies remain explicitly blocked while unrelated work continues.

Use event-driven wakeups plus polling from 30 seconds to 5 minutes while unchanged, both configurable.
Reset backoff on control commands, relevant events, plan changes, Worker transitions, or changed evidence.
An empty queue remains enabled and reports healthy idle state.

Architectural rationale: [Let persisted evidence control completion](../../../docs/adr/0005-evidence-controls-completion.md).
