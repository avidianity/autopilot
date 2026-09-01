import {
  DuplicateLaunchTokenError,
  DuplicateRunError,
  StaleLeaseError,
  WorktreeCollisionError,
} from "./errors.js"
import { cloneState, emptyState, type State } from "./state.js"
import { SqliteDriver } from "./sqlite-driver.js"
import { assertRunStatusTransition, assertWorkItemTransition } from "./transitions.js"
import {
  ACTIVE_RUN_STATUSES,
  type BeginAttemptInput,
  type CreateRunInput,
  type ObservedAttempt,
  type RunRecord,
  type RunSnapshot,
  type RunStatus,
  type StoreOptions,
  type SupervisorLeaseRecord,
  type TransitionRecord,
  type UpsertWorkItemInput,
  type WorkerAttemptRecord,
  type WorkItemRecord,
  type WorkItemStatus,
} from "./types.js"

export { StaleLeaseError, TransitionError } from "./errors.js"
export type {
  BeginAttemptInput,
  CreateRunInput,
  RunRecord,
  RunSnapshot,
  RunStatus,
  SupervisorLeaseRecord,
  UpsertWorkItemInput,
  WorkerAttemptRecord,
  WorkItemRecord,
  WorkItemStatus,
} from "./types.js"

export interface AutopilotMutation {
  setRunStatus(status: RunStatus, reason: string): RunRecord
  upsertWorkItem(input: UpsertWorkItemInput): WorkItemRecord
  transitionWorkItem(id: string, to: WorkItemStatus, reason: string): WorkItemRecord
  incrementFailedAttempts(id: string, by: number): WorkItemRecord
  reserveWorktree(workItemId: string, path: string, branch: string, baseSha?: string): void
  beginWorkerAttempt(input: BeginAttemptInput): WorkerAttemptRecord
  attachSession(attemptId: string, sessionId: string): WorkerAttemptRecord
  recordUnknown(workItemId: string, attemptId: string, reason: string): void
  listUnresolvedAttempts(): WorkerAttemptRecord[]
  getWorkItem(id: string): WorkItemRecord
}

interface StoreDriver {
  read<T>(fn: (state: State) => T): T
  transact<T>(fn: (state: State) => T): T
  close(): void
  reopen(): StoreDriver
}

class MemoryDriver implements StoreDriver {
  constructor(private state: State = emptyState()) {}

  read<T>(fn: (state: State) => T): T {
    return fn(cloneState(this.state))
  }

  transact<T>(fn: (state: State) => T): T {
    const next = cloneState(this.state)
    const result = fn(next)
    this.state = next
    return result
  }

  close(): void {}

  reopen(): MemoryDriver {
    return new MemoryDriver(cloneState(this.state))
  }
}

export class AutopilotStore {
  private constructor(
    private driver: StoreDriver,
    private readonly clock: () => number,
  ) {}

  static memory(options: StoreOptions = {}): AutopilotStore {
    return new AutopilotStore(new MemoryDriver(), options.clock ?? Date.now)
  }

  static sqlite(path: string, options: StoreOptions = {}): AutopilotStore {
    return new AutopilotStore(new SqliteDriver(path), options.clock ?? Date.now)
  }

  close(): void {
    this.driver.close()
  }

  reopen(): AutopilotStore {
    this.driver = this.driver.reopen()
    return this
  }

  createRun(input: CreateRunInput): RunRecord {
    return this.driver.transact((state) => {
      for (const run of state.runs.values()) {
        if (run.canonicalRoot === input.canonicalRoot && ACTIVE_RUN_STATUSES.has(run.status)) {
          throw new DuplicateRunError()
        }
      }
      const now = this.clock()
      const run: RunRecord = {
        id: crypto.randomUUID(),
        canonicalRoot: input.canonicalRoot,
        objective: input.objective,
        status: "enabled",
        autoResumeAfterRestart: input.autoResumeAfterRestart ?? false,
        concurrency: input.concurrency ?? 4,
        maxRetriesPerWorkItem: input.maxRetriesPerWorkItem ?? 3,
        pollIntervalMs: input.pollIntervalMs ?? 30_000,
        createdAt: now,
        updatedAt: now,
      }
      state.runs.set(run.id, run)
      appendTransition(state, {
        runId: run.id,
        entityType: "run",
        entityId: run.id,
        toStatus: run.status,
        reason: "created",
        fencingToken: 0,
        createdAt: now,
      })
      return { ...run }
    })
  }

  getRun(runId: string): RunRecord | undefined {
    return this.driver.read((state) => {
      const run = state.runs.get(runId)
      return run ? { ...run } : undefined
    })
  }

  getActiveRun(canonicalRoot: string): RunRecord | undefined {
    return this.driver.read((state) => {
      for (const run of state.runs.values()) {
        if (run.canonicalRoot === canonicalRoot && ACTIVE_RUN_STATUSES.has(run.status)) {
          return { ...run }
        }
      }
      return undefined
    })
  }

  getWorkItem(id: string): WorkItemRecord | undefined {
    return this.driver.read((state) => {
      const item = state.workItems.get(id)
      return item ? cloneWorkItem(item) : undefined
    })
  }

  findAttemptByLaunchToken(launchToken: string): WorkerAttemptRecord | undefined {
    return this.driver.read((state) => {
      for (const attempt of state.attempts.values()) {
        if (attempt.launchToken === launchToken) {
          return { ...attempt }
        }
      }
      return undefined
    })
  }

  acquireLease(runId: string, instanceId: string, ttlMs: number): SupervisorLeaseRecord {
    return this.driver.transact((state) => {
      requireRun(state, runId)
      const now = this.clock()
      const current = state.leases.get(runId)
      if (current && current.expiresAt > now && current.instanceId !== instanceId) {
        throw new StaleLeaseError()
      }
      const lease: SupervisorLeaseRecord = {
        runId,
        instanceId,
        fencingToken:
          current && current.instanceId === instanceId && current.expiresAt > now
            ? current.fencingToken
            : (current?.fencingToken ?? 0) + 1,
        expiresAt: now + ttlMs,
      }
      state.leases.set(runId, lease)
      return { ...lease }
    })
  }

  renewLease(
    runId: string,
    instanceId: string,
    fencingToken: number,
    ttlMs: number,
  ): SupervisorLeaseRecord {
    return this.driver.transact((state) => {
      const lease = requireLease(state, runId, fencingToken, this.clock())
      if (lease.instanceId !== instanceId) {
        throw new StaleLeaseError()
      }
      lease.expiresAt = this.clock() + ttlMs
      return { ...lease }
    })
  }

  mutate<T>(runId: string, fencingToken: number, fn: (tx: AutopilotMutation) => T): T {
    return this.driver.transact((state) => {
      const lease = requireLease(state, runId, fencingToken, this.clock())
      const tx = createMutation(state, runId, lease.fencingToken, this.clock)
      return fn(tx)
    })
  }

  listUnresolvedAttempts(runId: string): WorkerAttemptRecord[] {
    return this.driver.read((state) =>
      [...state.attempts.values()]
        .filter(
          (attempt) =>
            attempt.runId === runId &&
            (attempt.status === "launching" || attempt.status === "running"),
        )
        .map((attempt) => ({ ...attempt })),
    )
  }

  reconcileObservedAttempts(
    runId: string,
    fencingToken: number,
    observed: ObservedAttempt[],
  ): void {
    this.mutate(runId, fencingToken, (tx) => {
      for (const attempt of tx.listUnresolvedAttempts()) {
        const match = observed.find((entry) => entry.launchToken === attempt.launchToken)
        if (match?.sessionId && !attempt.sessionId) {
          tx.attachSession(attempt.id, match.sessionId)
          if (tx.getWorkItem(attempt.workItemId).status === "launching") {
            tx.transitionWorkItem(attempt.workItemId, "running", "session observed")
          }
          continue
        }
        if (!match || match.missing) {
          tx.recordUnknown(attempt.workItemId, attempt.id, "session missing during recovery")
        }
      }
    })
  }

  snapshot(runId: string): RunSnapshot {
    return this.driver.read((state) => {
      const run = requireRun(state, runId)
      const lease = state.leases.get(runId)
      return {
        run: { ...run },
        workItems: [...state.workItems.values()]
          .filter((item) => item.runId === runId)
          .map(cloneWorkItem),
        attempts: [...state.attempts.values()]
          .filter((attempt) => attempt.runId === runId)
          .map((attempt) => ({ ...attempt })),
        worktrees: [...state.worktrees.values()]
          .filter((tree) => tree.runId === runId)
          .map((tree) => ({ ...tree })),
        transitions: state.transitions
          .filter((entry) => entry.runId === runId)
          .map((entry) => ({ ...entry })),
        ...(lease ? { lease: { ...lease } } : {}),
      }
    })
  }
}

function createMutation(
  state: State,
  runId: string,
  fencingToken: number,
  clock: () => number,
): AutopilotMutation {
  return {
    setRunStatus(status, reason) {
      const run = requireRun(state, runId)
      assertRunStatusTransition(run.status, status)
      const fromStatus = run.status
      run.status = status
      run.updatedAt = clock()
      appendTransition(state, {
        runId,
        entityType: "run",
        entityId: runId,
        fromStatus,
        toStatus: status,
        reason,
        fencingToken,
        createdAt: run.updatedAt,
      })
      return { ...run }
    },
    upsertWorkItem(input) {
      const now = clock()
      if (input.sourceKey) {
        const matches = [...state.workItems.values()].filter(
          (item) => item.runId === runId && item.sourceKey === input.sourceKey,
        )
        const live = matches.find(
          (item) =>
            item.status !== "completed" &&
            item.status !== "cancelled" &&
            item.status !== "superseded",
        )
        if (live) {
          live.title = input.title
          live.objective = input.objective
          if (input.dependencies) {
            live.dependencies = [...input.dependencies]
          }
          if (input.contentFingerprint) {
            live.contentFingerprint = input.contentFingerprint
          }
          live.updatedAt = now
          return cloneWorkItem(live)
        }
        const completed = matches.find((item) => item.status === "completed")
        if (completed) {
          const previous = completed.contentFingerprint
          const next = input.contentFingerprint
          if (next === undefined || next === previous) {
            return cloneWorkItem(completed)
          }
          return createWorkItem(state, runId, input, now, fencingToken, completed.id)
        }
      }
      return createWorkItem(state, runId, input, now, fencingToken)
    },
    transitionWorkItem(id, to, reason) {
      const item = requireWorkItem(state, runId, id)
      assertWorkItemTransition(item.status, to)
      const fromStatus = item.status
      item.status = to
      item.updatedAt = clock()
      appendTransition(state, {
        runId,
        entityType: "work-item",
        entityId: id,
        fromStatus,
        toStatus: to,
        reason,
        fencingToken,
        createdAt: item.updatedAt,
      })
      return cloneWorkItem(item)
    },
    incrementFailedAttempts(id, by) {
      const item = requireWorkItem(state, runId, id)
      item.failedAttempts += by
      item.updatedAt = clock()
      return cloneWorkItem(item)
    },
    reserveWorktree(workItemId, path, branch, baseSha) {
      requireWorkItem(state, runId, workItemId)
      const existing = state.worktrees.get(workItemId)
      if (existing) {
        if (existing.path !== path || existing.branch !== branch) {
          throw new WorktreeCollisionError()
        }
        if (baseSha) {
          existing.baseSha = baseSha
        }
        return
      }
      for (const tree of state.worktrees.values()) {
        if (tree.path === path) {
          throw new WorktreeCollisionError()
        }
        if (tree.branch === branch) {
          throw new WorktreeCollisionError()
        }
      }
      state.worktrees.set(workItemId, {
        workItemId,
        runId,
        path,
        branch,
        ...(baseSha ? { baseSha } : {}),
      })
    },
    beginWorkerAttempt(input) {
      requireWorkItem(state, runId, input.workItemId)
      for (const attempt of state.attempts.values()) {
        if (attempt.launchToken === input.launchToken) {
          throw new DuplicateLaunchTokenError()
        }
      }
      const now = clock()
      const attempt: WorkerAttemptRecord = {
        id: crypto.randomUUID(),
        runId,
        workItemId: input.workItemId,
        launchToken: input.launchToken,
        status: "launching",
        createdAt: now,
        updatedAt: now,
      }
      state.attempts.set(attempt.id, attempt)
      appendTransition(state, {
        runId,
        entityType: "worker-attempt",
        entityId: attempt.id,
        toStatus: attempt.status,
        reason: "launch identity persisted",
        fencingToken,
        createdAt: now,
      })
      return { ...attempt }
    },
    attachSession(attemptId, sessionId) {
      const attempt = state.attempts.get(attemptId)
      if (!attempt || attempt.runId !== runId) {
        throw new Error(`Worker Attempt ${attemptId} not found`)
      }
      attempt.sessionId = sessionId
      attempt.status = "running"
      attempt.updatedAt = clock()
      appendTransition(state, {
        runId,
        entityType: "worker-attempt",
        entityId: attemptId,
        fromStatus: "launching",
        toStatus: "running",
        reason: "session attached",
        fencingToken,
        createdAt: attempt.updatedAt,
      })
      return { ...attempt }
    },
    listUnresolvedAttempts() {
      return [...state.attempts.values()]
        .filter(
          (attempt) =>
            attempt.runId === runId &&
            (attempt.status === "launching" || attempt.status === "running"),
        )
        .map((attempt) => ({ ...attempt }))
    },
    getWorkItem(id) {
      return cloneWorkItem(requireWorkItem(state, runId, id))
    },
    recordUnknown(workItemId, attemptId, reason) {
      const item = requireWorkItem(state, runId, workItemId)
      const attempt = state.attempts.get(attemptId)
      if (attempt && attempt.runId === runId) {
        const fromStatus = attempt.status
        attempt.status = "unknown"
        attempt.updatedAt = clock()
        appendTransition(state, {
          runId,
          entityType: "worker-attempt",
          entityId: attemptId,
          fromStatus,
          toStatus: "unknown",
          reason,
          fencingToken,
          createdAt: attempt.updatedAt,
        })
      }
      assertWorkItemTransition(item.status, "unknown")
      const fromStatus = item.status
      item.status = "unknown"
      item.updatedAt = clock()
      appendTransition(state, {
        runId,
        entityType: "work-item",
        entityId: workItemId,
        fromStatus,
        toStatus: "unknown",
        reason,
        fencingToken,
        createdAt: item.updatedAt,
      })
    },
  }
}

function createWorkItem(
  state: State,
  runId: string,
  input: UpsertWorkItemInput,
  now: number,
  fencingToken: number,
  predecessorId?: string,
): WorkItemRecord {
  const item: WorkItemRecord = {
    id: crypto.randomUUID(),
    runId,
    title: input.title,
    objective: input.objective,
    status: "pending",
    dependencies: input.dependencies ? [...input.dependencies] : [],
    failedAttempts: 0,
    createdAt: now,
    updatedAt: now,
  }
  if (input.sourceKey) {
    item.sourceKey = input.sourceKey
  }
  if (input.contentFingerprint) {
    item.contentFingerprint = input.contentFingerprint
  }
  if (predecessorId) {
    item.predecessorId = predecessorId
  }
  state.workItems.set(item.id, item)
  appendTransition(state, {
    runId,
    entityType: "work-item",
    entityId: item.id,
    toStatus: item.status,
    reason: predecessorId ? "successor created" : "created",
    fencingToken,
    createdAt: now,
  })
  return cloneWorkItem(item)
}

function appendTransition(
  state: State,
  entry: Omit<TransitionRecord, "id">,
): void {
  state.transitions.push({ id: state.nextTransitionId, ...entry })
  state.nextTransitionId += 1
}

function requireRun(state: State, runId: string): RunRecord {
  const run = state.runs.get(runId)
  if (!run) {
    throw new Error(`Autopilot Run ${runId} not found`)
  }
  return run
}

function requireWorkItem(state: State, runId: string, id: string): WorkItemRecord {
  const item = state.workItems.get(id)
  if (!item || item.runId !== runId) {
    throw new Error(`Work Item ${id} not found`)
  }
  return item
}

function requireLease(
  state: State,
  runId: string,
  fencingToken: number,
  now: number,
): SupervisorLeaseRecord {
  const lease = state.leases.get(runId)
  if (!lease || lease.fencingToken !== fencingToken || lease.expiresAt <= now) {
    throw new StaleLeaseError()
  }
  return lease
}

function cloneWorkItem(item: WorkItemRecord): WorkItemRecord {
  return { ...item, dependencies: [...item.dependencies] }
}
