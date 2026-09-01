import type { AutopilotStore } from "./core/store.js"
import { discoverEvidence } from "./planning/discover.js"
import { applyPlanFromEngine } from "./planning/planner.js"
import type { SemanticEngine } from "./planning/types.js"
import { DirectObjectiveSource, WorkSourceRegistry } from "./planning/sources.js"
import type { WorkSourceAdapter } from "./planning/types.js"
import { VerificationCatalog, VerificationEngine, createDefaultPlan } from "./verify/engine.js"
import type { GitPort, ProcessPort } from "./verify/types.js"
import { WorkerLifecycle, type WorktreePort } from "./workers/lifecycle.js"
import type { SessionRunner } from "./workers/session-runner.js"

export interface SupervisorDeps {
  store: AutopilotStore
  engine: SemanticEngine
  runner: SessionRunner
  worktrees: WorktreePort
  process: ProcessPort
  git: GitPort
  sources?: WorkSourceAdapter[]
  instanceId?: string
  canonicalRoot: string
  gitAvailable?: boolean
  autoResumeAfterRestart?: boolean
}

export class Supervisor {
  private readonly lifecycle: WorkerLifecycle
  private readonly verification: VerificationEngine
  private readonly catalog = new VerificationCatalog()
  private readonly registry = new WorkSourceRegistry()
  private readonly instanceId: string
  private runId: string | undefined
  private fencingToken = 0
  private pollMs = 30_000

  constructor(private readonly deps: SupervisorDeps) {
    this.instanceId = deps.instanceId ?? "supervisor"
    this.lifecycle = new WorkerLifecycle(deps.store, deps.runner, deps.worktrees)
    this.verification = new VerificationEngine(
      deps.store,
      this.catalog,
      deps.process,
      deps.git,
      deps.engine,
    )
    this.registry.register(new DirectObjectiveSource())
    for (const source of deps.sources ?? []) {
      this.registry.register(source)
    }
  }

  start(objective: string): string {
    const existing = this.deps.store.getActiveRun(this.deps.canonicalRoot)
    if (existing) {
      this.runId = existing.id
      const lease = this.deps.store.acquireLease(existing.id, this.instanceId, 60_000)
      this.fencingToken = lease.fencingToken
      return `Autopilot already running\n\nObjective:\n${existing.objective}`
    }
    const run = this.deps.store.createRun({
      canonicalRoot: this.deps.canonicalRoot,
      objective,
      autoResumeAfterRestart: this.deps.autoResumeAfterRestart ?? false,
    })
    const lease = this.deps.store.acquireLease(run.id, this.instanceId, 60_000)
    this.runId = run.id
    this.fencingToken = lease.fencingToken
    this.pollMs = run.pollIntervalMs
    return this.status()
  }

  pause(): string {
    this.mutate((tx) => tx.setRunStatus("paused", "pause"))
    return this.status()
  }

  resume(): string {
    const run = this.requireRun()
    if (run.status === "recovery-hold" || run.status === "paused") {
      this.mutate((tx) => tx.setRunStatus("enabled", "resume"))
    }
    return this.status()
  }

  stop(force = false): string {
    this.mutate((tx) => tx.setRunStatus(force ? "force-stopping" : "stopping", "stop"))
    if (force) {
      const snapshot = this.deps.store.snapshot(this.requireRun().id)
      for (const attempt of snapshot.attempts) {
        if (attempt.sessionId && (attempt.status === "running" || attempt.status === "launching")) {
          void this.lifecycle.abortSession({
            runId: snapshot.run.id,
            fencingToken: this.fencingToken,
            sessionId: attempt.sessionId,
          })
        }
      }
    }
    const snapshot = this.deps.store.snapshot(this.requireRun().id)
    const active = snapshot.workItems.some((item) =>
      ["launching", "running", "verifying", "integrating"].includes(item.status),
    )
    if (!active) {
      this.mutate((tx) => tx.setRunStatus("stopped", "drained"))
    }
    return this.status()
  }

  handleIdle(sessionId: string): void {
    const run = this.deps.store.getActiveRun(this.deps.canonicalRoot)
    if (!run) {
      return
    }
    this.lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: this.fencingToken,
      sessionId,
      kind: "idle",
    })
  }

  async tick(): Promise<void> {
    const run = this.deps.store.getActiveRun(this.deps.canonicalRoot)
    if (!run) {
      return
    }
    this.runId = run.id
    const lease = this.deps.store.renewLease(run.id, this.instanceId, this.fencingToken, 60_000)
    this.fencingToken = lease.fencingToken
    if (run.status === "paused" || run.status === "recovery-hold" || run.status === "stopped") {
      return
    }
    if (run.status === "stopping" || run.status === "force-stopping") {
      const snapshot = this.deps.store.snapshot(run.id)
      const active = snapshot.workItems.some((item) =>
        ["launching", "running", "verifying", "integrating"].includes(item.status),
      )
      if (!active) {
        this.mutate((tx) => tx.setRunStatus("stopped", "drained"))
      }
      return
    }
    await this.lifecycle.recover({ runId: run.id, fencingToken: this.fencingToken })
    const evidence = await discoverEvidence({
      objective: run.objective,
      engine: this.deps.engine,
      registry: this.registry,
    })
    const snapshot = this.deps.store.snapshot(run.id)
    await applyPlanFromEngine({
      store: this.deps.store,
      runId: run.id,
      fencingToken: this.fencingToken,
      engine: this.deps.engine,
      objective: run.objective,
      evidence,
      prior: snapshot.workItems.map((item) => ({
        ...(item.sourceKey ? { sourceKey: item.sourceKey } : {}),
        status: item.status,
      })),
    })
    const next = this.deps.store.snapshot(run.id)
    for (const item of next.workItems.filter((entry) => entry.status === "verifying")) {
      await this.verification.verifyAndIntegrate({
        runId: run.id,
        fencingToken: this.fencingToken,
        workItemId: item.id,
        worktree: `.autopilot/worktrees/${item.id}`,
        integrationCwd: ".autopilot/integration",
        baseRevision: "HEAD",
      })
    }
    await this.lifecycle.fillSlots({
      runId: run.id,
      fencingToken: this.fencingToken,
      ...(this.deps.gitAvailable === undefined ? {} : { gitAvailable: this.deps.gitAvailable }),
      instructionFor: (item) => {
        if (!this.catalog.get(item.id)) {
          this.catalog.freezePlan(createDefaultPlan(item))
        }
        return {
          prompt: item.objective,
        }
      },
    })
  }

  pollIntervalMs(): number {
    return this.pollMs
  }

  status(): string {
    const run = this.deps.store.getActiveRun(this.deps.canonicalRoot) ?? (this.runId ? this.deps.store.getRun(this.runId) : undefined)
    if (!run) {
      return "Autopilot: stopped\n\nNo Autopilot Run."
    }
    const snapshot = this.deps.store.snapshot(run.id)
    const running = snapshot.workItems.filter((item) => item.status === "running")
    const ready = snapshot.workItems.filter((item) => item.status === "ready")
    const blocked = snapshot.workItems.filter((item) => item.status === "blocked")
    const stuck = snapshot.workItems.filter((item) => item.status === "stuck")
    const completed = snapshot.workItems.filter((item) => item.status === "completed")
    const repairing = snapshot.workItems.filter((item) => item.status === "repairing")
    const label =
      run.status === "enabled" && running.length === 0 && ready.length === 0
        ? "idle"
        : run.status
    return [
      `Autopilot: ${label}`,
      "",
      "Objective:",
      run.objective,
      "",
      `Workers:`,
      `${running.length} / ${run.concurrency} active`,
      "",
      "Running:",
      running.length ? running.map((item) => item.title).join("\n") : "(none)",
      "",
      "Ready:",
      ready.length ? ready.map((item) => item.title).join("\n") : "(none)",
      "",
      "Blocked:",
      blocked.length ? blocked.map((item) => item.title).join("\n") : "(none)",
      "",
      "Retrying:",
      repairing.length ? repairing.map((item) => item.title).join("\n") : "(none)",
      "",
      "Stuck:",
      stuck.length ? stuck.map((item) => item.title).join("\n") : "(none)",
      "",
      "Completed this run:",
      `${completed.length} tasks`,
    ].join("\n")
  }

  private requireRun() {
    const run = this.runId ? this.deps.store.getRun(this.runId) : this.deps.store.getActiveRun(this.deps.canonicalRoot)
    if (!run) {
      throw new Error("no Autopilot Run")
    }
    return run
  }

  private mutate<T>(fn: Parameters<AutopilotStore["mutate"]>[2]): T {
    const run = this.requireRun()
    return this.deps.store.mutate(run.id, this.fencingToken, fn) as T
  }
}

export function parseAutopilotInput(input: string): {
  action: "start" | "status" | "pause" | "resume" | "stop"
  force?: boolean
  objective?: string
} {
  const trimmed = input.trim()
  if (trimmed === "" || trimmed === "status") {
    return { action: "status" }
  }
  if (trimmed === "pause") {
    return { action: "pause" }
  }
  if (trimmed === "resume") {
    return { action: "resume" }
  }
  if (trimmed === "stop") {
    return { action: "stop" }
  }
  if (trimmed.startsWith("stop --force")) {
    return { action: "stop", force: true }
  }
  return { action: "start", objective: trimmed }
}
