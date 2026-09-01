# Implement discovery, planning, and Capability core

Type: task
Status: resolved
Blocked by: 07

## Question

Implement Work Source selection and adapters, immutable Discovery Evidence, validated plan reconciliation, Semantic Engine contracts and OpenCode adapter, runtime Capability snapshots, and dynamic Worker Instruction strategies with raw-prompt fallback.

## Answer

Planning core is a schema-constrained Semantic Engine plus deterministic apply/compile code.

Implemented:

- Objective interpretation selects Work Sources; only those adapters run
- Immutable Discovery Evidence from registered adapters, including `DirectObjectiveSource`
- Validated plan apply: cycle rejection, no Worker launch, no rewrite of executing Work Items or retry counts
- Invalid semantic output retries then a blocked `diagnostic:semantic-plan` Work Item
- Scripted test engine and OpenCode completion-port adapter
- Immutable Capability snapshots
- Worker Instruction compiler requiring explicit fit evidence before specialized commands, otherwise raw prompt fallback

Verification: `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`.
