export type RunStatus =
  | "enabled"
  | "paused"
  | "recovery-hold"
  | "stopping"
  | "force-stopping"
  | "stopped"

export type WorkItemStatus =
  | "pending"
  | "blocked"
  | "ready"
  | "launching"
  | "running"
  | "verifying"
  | "integrating"
  | "completed"
  | "repairing"
  | "stuck"
  | "superseded"
  | "cancelled"
  | "unknown"

export type AttemptStatus = "launching" | "running" | "completed" | "failed" | "unknown"

export interface RunRecord {
  id: string
  canonicalRoot: string
  objective: string
  status: RunStatus
  autoResumeAfterRestart: boolean
  concurrency: number
  maxRetriesPerWorkItem: number
  pollIntervalMs: number
  createdAt: number
  updatedAt: number
}

export interface WorkItemRecord {
  id: string
  runId: string
  title: string
  objective: string
  status: WorkItemStatus
  dependencies: string[]
  failedAttempts: number
  sourceKey?: string
  contentFingerprint?: string
  predecessorId?: string
  createdAt: number
  updatedAt: number
}

export interface WorkerAttemptRecord {
  id: string
  runId: string
  workItemId: string
  launchToken: string
  status: AttemptStatus
  sessionId?: string
  createdAt: number
  updatedAt: number
}

export interface WorktreeReservation {
  workItemId: string
  runId: string
  path: string
  branch: string
}

export interface SupervisorLeaseRecord {
  runId: string
  instanceId: string
  fencingToken: number
  expiresAt: number
}

export interface TransitionRecord {
  id: number
  runId: string
  entityType: "run" | "work-item" | "worker-attempt"
  entityId: string
  fromStatus?: string
  toStatus: string
  reason: string
  fencingToken: number
  createdAt: number
}

export interface RunSnapshot {
  run: RunRecord
  workItems: WorkItemRecord[]
  attempts: WorkerAttemptRecord[]
  worktrees: WorktreeReservation[]
  transitions: TransitionRecord[]
  lease?: SupervisorLeaseRecord
}

export interface CreateRunInput {
  canonicalRoot: string
  objective: string
  autoResumeAfterRestart?: boolean
  concurrency?: number
  maxRetriesPerWorkItem?: number
  pollIntervalMs?: number
}

export interface UpsertWorkItemInput {
  title: string
  objective: string
  sourceKey?: string
  contentFingerprint?: string
  dependencies?: string[]
}

export interface BeginAttemptInput {
  workItemId: string
  launchToken: string
}

export interface ObservedAttempt {
  launchToken: string
  sessionId?: string
  missing?: boolean
}

export interface StoreOptions {
  clock?: () => number
}

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "enabled",
  "paused",
  "recovery-hold",
  "stopping",
  "force-stopping",
])
