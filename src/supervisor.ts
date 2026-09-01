import { StaleLeaseError, type AutopilotStore } from "./core/store.js"
import { buildCapabilitySnapshot } from "./planning/capabilities.js"
import { compileWorkerInstruction } from "./planning/compiler.js"
import { discoverEvidence } from "./planning/discover.js"
import { applyPlanFromEngine } from "./planning/planner.js"
import type { Capability, SemanticEngine } from "./planning/types.js"
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
  capabilities?: Capability[]
  onTickError?: (error: unknown) => void
  pollIntervalMs?: number
  catalogPath?: string
  leaseTtlMs?: number
}

export class Supervisor {
  private readonly lifecycle: WorkerLifecycle
  private readonly verification: VerificationEngine
  private readonly catalog: VerificationCatalog
  private readonly registry = new WorkSourceRegistry()
  readonly instanceId: string
  private readonly capabilities: Capability[]
  private runId: string | undefined
  private fencingToken = 0
  private pollMs = 30_000
  private createdThisProcess = false
  private looping = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private backoffMs = 30_000
  private lastSignature = ""
  private lastTickError: string | undefined
  private readonly leaseTtlMs: number
  private readonly maxBackoffMs: number

  constructor(private readonly deps: SupervisorDeps) {
    this.instanceId = deps.instanceId ?? crypto.randomUUID()
    this.leaseTtlMs = deps.leaseTtlMs ?? 60_000
    this.maxBackoffMs = Math.max(1_000, this.leaseTtlMs - 15_000)
    this.capabilities =
      deps.capabilities ??
      buildCapabilitySnapshot({
        commands: [],
        skills: [],
        agents: [],
        tools: [],
        mcp: [],
        repository: [],
      })
    this.lifecycle = new WorkerLifecycle(deps.store, deps.runner, deps.worktrees)
    this.catalog = new VerificationCatalog(deps.catalogPath)
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

  sourceIds(): string[] {
    return [
      "direct-objective",
      ...(this.deps.sources ?? []).map((source) => source.id),
    ]
  }

  start(objective: string): string {
    const existing = this.deps.store.getActiveRun(this.deps.canonicalRoot)
    if (existing) {
      this.runId = existing.id
      this.pollMs = existing.pollIntervalMs
      const lease = this.deps.store.acquireLease(existing.id, this.instanceId, 60_000)
      this.fencingToken = lease.fencingToken
      this.applyRecoveryHold(existing)
      this.ensureLoop()
      return `Autopilot already running\n\nObjective:\n${existing.objective}`
    }
    const run = this.deps.store.createRun({
      canonicalRoot: this.deps.canonicalRoot,
      objective,
      autoResumeAfterRestart: this.deps.autoResumeAfterRestart ?? false,
      ...(this.deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.deps.pollIntervalMs }),
    })
    const lease = this.deps.store.acquireLease(run.id, this.instanceId, 60_000)
    this.runId = run.id
    this.fencingToken = lease.fencingToken
    this.pollMs = run.pollIntervalMs
    this.createdThisProcess = true
    this.backoffMs = this.pollMs
    this.ensureLoop()
    return this.status()
  }

  pause(): string {
    this.ensureLoop()
    this.mutate((tx) => tx.setRunStatus("paused", "pause"))
    return this.status()
  }

  resume(): string {
    this.ensureLoop()
    const run = this.requireRun()
    if (run.status === "recovery-hold" || run.status === "paused") {
      this.mutate((tx) => tx.setRunStatus("enabled", "resume"))
    }
    this.backoffMs = this.pollMs
    return this.status()
  }

  stop(force = false): string {
    this.ensureLoop()
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
      this.dispose()
    }
    return this.status()
  }

  dispose(): void {
    this.disposed = true
    this.looping = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.deps.store.close()
  }

  ensureLoop(): void {
    if (this.looping || this.disposed) {
      return
    }
    this.looping = true
    this.timer = setTimeout(() => {
      void this.loopOnce()
    }, 0)
  }

  handleIdle(sessionId: string): void {
    this.handleSessionHook(sessionId, "idle")
  }

  handleSessionHook(sessionId: string, kind: "idle" | "error" | "abort"): void {
    const run = this.deps.store.getActiveRun(this.deps.canonicalRoot)
    if (!run) {
      return
    }
    this.lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: this.fencingToken,
      sessionId,
      kind,
    })
    this.backoffMs = this.pollMs
    void this.safeTick()
  }

  async tick(): Promise<void> {
    const run = this.deps.store.getActiveRun(this.deps.canonicalRoot)
    if (!run) {
      return
    }
    this.runId = run.id
    this.pollMs = run.pollIntervalMs
    try {
      const lease = this.deps.store.renewLease(run.id, this.instanceId, this.fencingToken, this.leaseTtlMs)
      this.fencingToken = lease.fencingToken
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        const lease = this.deps.store.acquireLease(run.id, this.instanceId, this.leaseTtlMs)
        this.fencingToken = lease.fencingToken
      } else {
        throw error
      }
    }
    this.applyRecoveryHold(run)
    const current = this.deps.store.getRun(run.id) ?? run
    if (current.status === "paused" || current.status === "recovery-hold" || current.status === "stopped") {
      return
    }
    if (current.status === "stopping" || current.status === "force-stopping") {
      const snapshot = this.deps.store.snapshot(run.id)
      const active = snapshot.workItems.some((item) =>
        ["launching", "running", "verifying", "integrating"].includes(item.status),
      )
      if (!active) {
        this.mutate((tx) => tx.setRunStatus("stopped", "drained"))
        this.dispose()
      }
      return
    }
    await this.lifecycle.recover({ runId: run.id, fencingToken: this.fencingToken })
    const evidence = await discoverEvidence({
      objective: current.objective,
      engine: this.deps.engine,
      registry: this.registry,
    })
    const snapshot = this.deps.store.snapshot(run.id)
    await applyPlanFromEngine({
      store: this.deps.store,
      runId: run.id,
      fencingToken: this.fencingToken,
      engine: this.deps.engine,
      objective: current.objective,
      evidence,
      prior: snapshot.workItems.map((item) => ({
        ...(item.sourceKey ? { sourceKey: item.sourceKey } : {}),
        status: item.status,
      })),
    })
    const next = this.deps.store.snapshot(run.id)
    const integrationPath = `.autopilot/runs/${run.id}`
    const integrationBranch = `autopilot/${run.id}`
    if (this.deps.gitAvailable !== false) {
      await this.deps.worktrees.ensure(integrationPath, integrationBranch)
    }
    for (const item of next.workItems.filter((entry) => entry.status === "verifying")) {
      const tree = next.worktrees.find((entry) => entry.workItemId === item.id)
      const worktree = tree?.path ?? `.autopilot/worktrees/${item.id}`
      const baseRevision = tree?.baseSha ?? this.deps.git.head(worktree)
      await this.verification.verifyAndIntegrate({
        runId: run.id,
        fencingToken: this.fencingToken,
        workItemId: item.id,
        worktree,
        integrationCwd: integrationPath,
        baseRevision,
      })
    }
    await this.lifecycle.fillSlots({
      runId: run.id,
      fencingToken: this.fencingToken,
      ...(this.deps.gitAvailable === undefined ? {} : { gitAvailable: this.deps.gitAvailable }),
      instructionFor: async (item) => {
        if (!this.catalog.get(item.id)) {
          this.catalog.freezePlan(createDefaultPlan(item))
        }
        return compileWorkerInstruction({
          engine: this.deps.engine,
          objective: current.objective,
          workItem: { id: item.id, title: item.title, objective: item.objective },
          capabilities: this.capabilities,
        })
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
    const lines = [
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
    ]
    if (this.lastTickError) {
      lines.push("", "Last tick error:", this.lastTickError)
    }
    return lines.join("\n")
  }

  private applyRecoveryHold(run: { id: string; status: string; autoResumeAfterRestart: boolean }): void {
    if (this.createdThisProcess) {
      return
    }
    if (run.status === "enabled" && run.autoResumeAfterRestart === false) {
      this.mutate((tx) => tx.setRunStatus("recovery-hold", "restart"))
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick()
      this.lastTickError = undefined
    } catch (error) {
      this.lastTickError = error instanceof Error ? error.message : String(error)
      this.deps.onTickError?.(error)
    }
  }

  private async loopOnce(): Promise<void> {
    if (this.disposed) {
      this.looping = false
      return
    }
    try {
      const before = this.signature()
      await this.safeTick()
      const after = this.signature()
      if (after === before && after === this.lastSignature) {
        this.backoffMs = Math.min(Math.max(this.backoffMs, this.pollMs) * 2, this.maxBackoffMs)
      } else {
        this.backoffMs = this.pollMs
      }
      this.lastSignature = after
      if (this.disposed) {
        this.looping = false
        return
      }
      this.holdLease()
    } catch (error) {
      this.lastTickError = error instanceof Error ? error.message : String(error)
      this.deps.onTickError?.(error)
    }
    if (this.disposed) {
      this.looping = false
      return
    }
    this.timer = setTimeout(() => {
      void this.loopOnce()
    }, this.backoffMs)
  }

  private holdLease(): void {
    const active = this.deps.store.getActiveRun(this.deps.canonicalRoot)
    if (!active) {
      return
    }
    try {
      const lease = this.deps.store.renewLease(active.id, this.instanceId, this.fencingToken, this.leaseTtlMs)
      this.fencingToken = lease.fencingToken
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        try {
          const lease = this.deps.store.acquireLease(active.id, this.instanceId, this.leaseTtlMs)
          this.fencingToken = lease.fencingToken
        } catch (acquireError) {
          this.lastTickError = acquireError instanceof Error ? acquireError.message : String(acquireError)
        }
      }
    }
  }

  private signature(): string {
    const run = this.deps.store.getActiveRun(this.deps.canonicalRoot)
    if (!run) {
      return "none"
    }
    const snapshot = this.deps.store.snapshot(run.id)
    return JSON.stringify({
      status: snapshot.run.status,
      items: snapshot.workItems.map((item) => `${item.id}:${item.status}`),
    })
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
  const parts = trimmed.split(/\s+/)
  if (parts[0] === "stop") {
    return { action: "stop", ...(parts.includes("--force") ? { force: true } : {}) }
  }
  return { action: "start", objective: trimmed }
}
