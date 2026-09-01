import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { isAbsolute, resolve } from "node:path"

import type { AutopilotStore } from "../core/store.js"
import type { WorkItemRecord } from "../core/types.js"
import type { WorkerInstruction } from "../planning/types.js"
import { decodeLaunchTitle, encodeLaunchTitle, type SessionRunner } from "./session-runner.js"

const SLOT_STATUSES = new Set(["launching", "running"])
const READY_DEPENDENCY_STATUS = "completed"

export interface WorktreePort {
  ensure(path: string, branch: string, startPoint?: string): Promise<string | undefined>
}

export class GitWorktreePort implements WorktreePort {
  constructor(private readonly root: string) {}

  async ensure(path: string, branch: string, startPoint?: string): Promise<string | undefined> {
    const absolute = resolveUnderRoot(this.root, path)
    if (!existsSync(absolute)) {
      const from = startPoint ? resolveStartPoint(this.root, startPoint) : undefined
      const addArgs = from
        ? ["worktree", "add", "-b", branch, absolute, from]
        : ["worktree", "add", "-b", branch, absolute]
      const result = spawnSync("git", addArgs, {
        cwd: this.root,
        encoding: "utf8",
      })
      if (result.status !== 0) {
        const retryArgs = from
          ? ["worktree", "add", absolute, from]
          : ["worktree", "add", absolute, branch]
        const retry = spawnSync("git", retryArgs, {
          cwd: this.root,
          encoding: "utf8",
        })
        if (retry.status !== 0) {
          throw new Error(result.stderr || retry.stderr || "git worktree add failed")
        }
      }
    }
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: absolute,
      encoding: "utf8",
    })
    return head.status === 0 ? head.stdout.trim() : undefined
  }
}

export class InMemoryWorktreePort implements WorktreePort {
  readonly reserved: Array<{ path: string; branch: string; startPoint?: string }> = []

  async ensure(path: string, branch: string, startPoint?: string): Promise<string | undefined> {
    if (!this.reserved.some((entry) => entry.path === path && entry.branch === branch)) {
      this.reserved.push(startPoint ? { path, branch, startPoint } : { path, branch })
    }
    return "base-sha"
  }
}

export function resolveUnderRoot(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path)
}

function resolveStartPoint(root: string, startPoint: string): string {
  const candidate = resolveUnderRoot(root, startPoint)
  if (existsSync(candidate)) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: candidate,
      encoding: "utf8",
    })
    if (head.status === 0 && head.stdout.trim()) {
      return head.stdout.trim()
    }
  }
  return startPoint
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
    instructionFor: (item: WorkItemRecord) => WorkerInstruction | Promise<WorkerInstruction>
    fileScopes?: ReadonlyMap<string, string[]>
    gitAvailable?: boolean
    canonicalRoot?: string
    startPoint?: string
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
      .filter(
        (item) =>
          (item.status === "ready" || item.status === "repairing") &&
          this.dependenciesMet(item, snapshot.workItems),
      )
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
      const existing = snapshot.worktrees.find((tree) => tree.workItemId === item.id)
      const relative = existing?.path ?? `.autopilot/worktrees/${item.id}`
      const path = input.canonicalRoot ? resolveUnderRoot(input.canonicalRoot, relative) : relative
      const branch = existing?.branch ?? `autopilot/${item.id}`
      const attempt = this.store.mutate(input.runId, input.fencingToken, (tx) => {
        tx.reserveWorktree(item.id, path, branch, existing?.baseSha)
        tx.transitionWorkItem(item.id, "launching", "schedule")
        return tx.beginWorkerAttempt({ workItemId: item.id, launchToken })
      })
      if (input.gitAvailable !== false) {
        const baseSha = await this.worktrees.ensure(path, branch, input.startPoint)
        if (baseSha && !existing?.baseSha) {
          this.store.mutate(input.runId, input.fencingToken, (tx) => {
            tx.reserveWorktree(item.id, path, branch, baseSha)
          })
        }
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
      await this.runner.prompt(session.id, await input.instructionFor(item))
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
    this.leaveUnknown(input.runId, input.fencingToken, attempt.workItemId)
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
    for (const item of this.store.snapshot(input.runId).workItems) {
      if (item.status === "unknown") {
        this.leaveUnknown(input.runId, input.fencingToken, item.id)
      }
    }
  }

  leaveUnknown(runId: string, fencingToken: number, workItemId: string): void {
    const max = this.store.getRun(runId)?.maxRetriesPerWorkItem ?? 3
    this.store.mutate(runId, fencingToken, (tx) => {
      const item = tx.getWorkItem(workItemId)
      if (item.status !== "unknown") {
        return
      }
      tx.incrementFailedAttempts(item.id, 1)
      const attempts = tx.getWorkItem(item.id).failedAttempts
      if (attempts < max) {
        tx.transitionWorkItem(item.id, "repairing", "retry after unknown")
        return
      }
      tx.transitionWorkItem(item.id, "stuck", "retries exhausted after unknown")
    })
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
