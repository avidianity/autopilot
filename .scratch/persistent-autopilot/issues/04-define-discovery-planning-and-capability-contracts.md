# Define discovery, planning, and Capability contracts

Type: grilling
Status: resolved
Blocked by: 01

## Question

What stable interfaces and structured outputs should separate objective interpretation, relevant-source selection, work discovery, planning, Capability discovery, and Worker Instruction compilation while keeping semantic models replaceable and scheduler control deterministic?

## Answer

Objective interpretation returns a schema-validated, ranked selection of Work Sources with reasons and source-specific query hints.
Run only selected source adapters rather than indiscriminately scanning the repository.
Each adapter emits immutable Discovery Evidence with stable source identity, content fingerprint, provenance, and source metadata; adapters never create or mutate Work Items.

The Semantic Engine proposes a complete structured reconciliation from the Autopilot Objective, prior plan, and current Discovery Evidence.
Deterministic code validates and transactionally applies that proposal.
Stable source keys preserve Work Item identity and status.
Planning may add, update, supersede, prioritize, or block pending items, but cannot erase running or completed history, reset retries, create dependency cycles, or launch Workers.
Changed evidence for completed work creates a linked successor Work Item rather than reopening history.

Expose one deep Semantic Engine interface using discriminated operation requests and schema-validated results for objective interpretation, planning, Worker Instruction compilation, and semantic verification.
The first adapter uses bounded OpenCode sessions; scheduler tests use deterministic scripted adapters.
Invalid semantic output is retried with validation feedback under a configurable operation limit, then becomes a diagnostic blocked item while unrelated work continues.
Unsafe ambiguity is never guessed into execution.

Build an immutable Capability snapshot from runtime commands, skills, agents, tools, MCP state, repository facilities, and resolved config.
Refresh at startup, each discovery cycle, immediately before compilation, and on relevant runtime events.
Each Capability records provenance, description, constraints, and invocation shape.
Instruction strategies rank applicable Capabilities and choose specialized invocation only with explicit fit evidence; raw prompts remain universal fallback.
Scheduler core contains no third-party Capability names, while optional adapters may enrich metadata.

Architectural rationale: [Isolate semantic reasoning behind structured operations](../../../docs/adr/0003-structured-semantic-engine-seam.md).
