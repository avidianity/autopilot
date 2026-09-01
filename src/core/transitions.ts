import { TransitionError } from "./errors.js"
import type { RunStatus, WorkItemStatus } from "./types.js"

const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, ReadonlySet<WorkItemStatus>> = {
  pending: new Set(["blocked", "ready", "cancelled", "superseded"]),
  blocked: new Set(["ready", "cancelled", "superseded", "stuck"]),
  ready: new Set(["launching", "blocked", "cancelled", "superseded"]),
  launching: new Set(["running", "unknown", "cancelled"]),
  running: new Set(["verifying", "unknown", "cancelled", "repairing"]),
  verifying: new Set(["integrating", "repairing", "stuck", "unknown"]),
  integrating: new Set(["completed", "repairing", "unknown"]),
  repairing: new Set(["launching", "stuck", "cancelled"]),
  stuck: new Set(["ready", "cancelled", "superseded"]),
  unknown: new Set(["launching", "repairing", "cancelled", "stuck"]),
  completed: new Set(),
  superseded: new Set(),
  cancelled: new Set(),
}

const RUN_TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  enabled: new Set(["paused", "stopping", "force-stopping", "recovery-hold"]),
  paused: new Set(["enabled", "stopping", "force-stopping"]),
  "recovery-hold": new Set(["enabled", "paused", "stopping", "force-stopping"]),
  stopping: new Set(["stopped"]),
  "force-stopping": new Set(["stopped"]),
  stopped: new Set(),
}

export function assertWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (!WORK_ITEM_TRANSITIONS[from].has(to)) {
    throw new TransitionError(from, to)
  }
}

export function assertRunStatusTransition(from: RunStatus, to: RunStatus): void {
  if (!RUN_TRANSITIONS[from].has(to)) {
    throw new TransitionError(from, to)
  }
}
