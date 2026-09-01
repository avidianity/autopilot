import type {
  RunRecord,
  SupervisorLeaseRecord,
  TransitionRecord,
  WorkerAttemptRecord,
  WorkItemRecord,
  WorktreeReservation,
} from "./types.js"

export interface State {
  runs: Map<string, RunRecord>
  workItems: Map<string, WorkItemRecord>
  attempts: Map<string, WorkerAttemptRecord>
  worktrees: Map<string, WorktreeReservation>
  leases: Map<string, SupervisorLeaseRecord>
  transitions: TransitionRecord[]
  nextTransitionId: number
}

export function emptyState(): State {
  return {
    runs: new Map(),
    workItems: new Map(),
    attempts: new Map(),
    worktrees: new Map(),
    leases: new Map(),
    transitions: [],
    nextTransitionId: 1,
  }
}

export function cloneState(state: State): State {
  return {
    runs: new Map(
      [...state.runs.entries()].map(([id, run]) => [id, { ...run }]),
    ),
    workItems: new Map(
      [...state.workItems.entries()].map(([id, item]) => [
        id,
        { ...item, dependencies: [...item.dependencies] },
      ]),
    ),
    attempts: new Map(
      [...state.attempts.entries()].map(([id, attempt]) => [id, { ...attempt }]),
    ),
    worktrees: new Map(
      [...state.worktrees.entries()].map(([id, tree]) => [id, { ...tree }]),
    ),
    leases: new Map(
      [...state.leases.entries()].map(([id, lease]) => [id, { ...lease }]),
    ),
    transitions: state.transitions.map((entry) => ({ ...entry })),
    nextTransitionId: state.nextTransitionId,
  }
}
