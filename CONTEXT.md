# Autopilot

Autopilot coordinates persistent, objective-driven work across bounded OpenCode sessions while keeping control state outside those sessions.

## Language

**Autopilot Objective**:
The original user instruction that governs one Autopilot Run until the user explicitly stops it.
_Avoid_: Prompt, task

**Autopilot Run**:
A persistent execution context that repeatedly discovers and coordinates work for one Autopilot Objective.
_Avoid_: Job, conversation, session

**Supervisor**:
The deterministic controller that owns an Autopilot Run's state, scheduling, recovery, and lifetime.
_Avoid_: Agent, worker, orchestrator

**Work Item**:
A structured, bounded unit of work derived from discovery and tracked by the Supervisor through planning, execution, and verification.
_Avoid_: Issue, ticket, prompt

**Worker**:
A fresh OpenCode session responsible for one bounded Work Item, never for the lifetime or completion of the Autopilot Run.
_Avoid_: Subagent, supervisor

**Capability**:
A discovered command, skill, agent, tool, repository facility, or executable workflow that may help complete a Work Item.
_Avoid_: Integration, plugin

**Work Source**:
A selectable origin from which Autopilot can discover evidence relevant to an Autopilot Objective.
_Avoid_: Tracker, queue, adapter

**Discovery Evidence**:
An immutable, source-identified observation that a planner may translate into one or more Work Items.
_Avoid_: Work Item, task, issue

**Semantic Engine**:
The replaceable reasoning interface that performs schema-constrained objective interpretation, planning, Worker Instruction compilation, and semantic verification without owning control state.
_Avoid_: Supervisor, model, planner

**Worker Instruction**:
The task-specific command or prompt compiled from a Work Item, the Autopilot Objective, and available Capabilities.
_Avoid_: Global prompt, worker task

**Recovery Hold**:
The post-restart state in which an Autopilot Run has been restored and reconciled but awaits explicit resume before scheduling new Work Items.
_Avoid_: Paused, stopped, running

**Supervisor Lease**:
The durable, time-bounded ownership record that grants one Supervisor instance authority to mutate an Autopilot Run.
_Avoid_: Lock, leader

**Worker Attempt**:
One uniquely identified invocation of a Worker for a Work Item, including retries and repair work.
_Avoid_: Worker, retry, session

**Run Branch**:
The dedicated Git branch that accumulates verified Work Item commits for one Autopilot Run without mutating the user's checked-out branch.
_Avoid_: Base branch, worker branch

**Integration Lane**:
The serialized transition that applies one verified Work Item commit range to the Run Branch and records resulting evidence.
_Avoid_: Merge queue, Worker

**Verification Plan**:
The persisted, task-aware acceptance contract established before Worker launch and used to evaluate implementation and integration evidence.
_Avoid_: Test plan, Worker checklist

**Verification Evidence**:
The recorded deterministic and semantic observations used to decide whether a Worker Attempt satisfies its Verification Plan.
_Avoid_: Worker report, result
