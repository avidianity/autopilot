import type { AutopilotStore } from "../core/store.js"
import type { WorkItemRecord } from "../core/types.js"
import type { WorkerInstruction } from "../planning/types.js"
import { decodeLaunchTitle, encodeLaunchTitle, type SessionRunner } from "./session-runner.js"

const SLOT_STATUSES = new Set(["launching", "running"])
const READY_DEPENDENCY_STATUS = "completed"

export interface WorktreePort {
  reserve(path: string, branch: string): Promise<void>
}

export class InMemoryWorktreePort implements WorktreePort {
  readonly reserved: Array<{ path: string; branch: string }> = []

  async reserve(path: string, branch: string): Promise<void> {
    this.reserved.push({ path, branch })
  }
}

export class WorkerLifecycle {
  constructor(
    private readonly store: AutopilotStore,
    private readonly runner: SessionRunner,
    private readonly worktrees: WorktreePort,
  ) {}

  async fillSlots(input: {
    runId: string
    fencingToken: number
    instructionFor: (item: WorkItemRecord) => WorkerInstruction
    fileScopes?: ReadonlyMap<string, string[]>
    gitAvailable?: boolean
  }): Promise<void> {
    const snapshot = this.store.snapshot(input.runId)
    if (snapshot.run.status !== "enabled") {
      return
    }
    const limit =
      input.gitAvailable === false ? 1 : snapshot.run.concurrency
    const active = snapshot.workItems.filter((item) => SLOT_STATUSES.has(item.status))
    let free = Math.max(0, limit - active.length)
    const activeFiles = new Set(
      active.flatMap((item) => input.fileScopes?.get(item.id) ?? []),
    )
    const ready = snapshot.workItems
      .filter((item) => item.status === "ready" && this.dependenciesMet(item, snapshot.workItems))
      .sort((left, right) => left.createdAt - right.createdAt)

    for (const item of ready) {
      if (free === 0) {
        break
      }
      const scope = input.fileScopes?.get(item.id) ?? []
      if (scope.some((file) => activeFiles.has(file))) {
        continue
      }
      const launchToken = crypto.randomUUID()
      const path = `.autopilot/worktrees/${item.id}`
      const branch = `autopilot/${item.id}`
      const attempt = this.store.mutate(input.runId, input.fencingToken, (tx) => {
        tx.reserveWorktree(item.id, path, branch)
        tx.transitionWorkItem(item.id, "launching", "schedule")
        return tx.beginWorkerAttempt({ workItemId: item.id, launchToken })
      })
      if (input.gitAvailable !== false) {
        await this.worktrees.reserve(path, branch)
      }
      const session = await this.runner.create({
        title: encodeLaunchTitle({
          runId: input.runId,
          workItemId: item.id,
          launchToken,
        }),
        ...(input.gitAvailable === false ? {} : { workingDirectory: path }),
      })
      this.store.mutate(input.runId, input.fencingToken, (tx) => {
        tx.attachSession(attempt.id, session.id)
        tx.transitionWorkItem(item.id, "running", "session attached")
      })
      await this.runner.prompt(session.id, input.instructionFor(item))
      for (const file of scope) {
        activeFiles.add(file)
      }
      free -= 1
    }
  }

  handleSessionEvent(input: {
    runId: string
    fencingToken: number
    sessionId: string
    kind: "idle" | "error" | "abort"
  }): void {
    const attempt = this.store
      .snapshot(input.runId)
      .attempts.find((entry) => entry.sessionId === input.sessionId)
    if (!attempt) {
      return
    }
    this.store.mutate(input.runId, input.fencingToken, (tx) => {
      const item = tx.getWorkItem(attempt.workItemId)
      if (input.kind === "idle" && item.status === "running") {
        tx.transitionWorkItem(item.id, "verifying", "session idle")
        return
      }
      if (item.status === "running" || item.status === "launching") {
        tx.recordUnknown(item.id, attempt.id, `session ${input.kind}`)
      }
    })
  }

  async abortSession(input: { runId: string; fencingToken: number; sessionId: string }): Promise<void> {
    await this.runner.abort(input.sessionId)
    this.handleSessionEvent({
      runId: input.runId,
      fencingToken: input.fencingToken,
      sessionId: input.sessionId,
      kind: "abort",
    })
  }

  async recover(input: { runId: string; fencingToken: number }): Promise<void> {
    const listed = await this.runner.list()
    const observed = listed.flatMap((session) => {
      const decoded = decodeLaunchTitle(session.title)
      if (!decoded || decoded.runId !== input.runId) {
        return []
      }
      return [{ launchToken: decoded.launchToken, sessionId: session.id }]
    })
    this.store.reconcileObservedAttempts(input.runId, input.fencingToken, observed)
  }

  private dependenciesMet(item: WorkItemRecord, items: WorkItemRecord[]): boolean {
    return item.dependencies.every((dependency) =>
      items.some(
        (candidate) =>
          candidate.status === READY_DEPENDENCY_STATUS &&
          (candidate.id === dependency || candidate.sourceKey === dependency),
      ),
    )
  }
}
