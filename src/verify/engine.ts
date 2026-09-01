import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import type { AutopilotStore } from "../core/store.js"
import type { WorkItemRecord } from "../core/types.js"
import type { SemanticEngine } from "../planning/types.js"
import { runValidated } from "../planning/semantic-engine.js"
import type {
  GitPort,
  ProcessPort,
  VerificationCheck,
  VerificationCheckResult,
  VerificationPlan,
  VerificationResult,
} from "./types.js"

export class VerificationCatalog {
  private readonly plans = new Map<string, VerificationPlan>()
  private readonly baseline = new Map<string, number>()

  constructor(private readonly persistPath?: string) {
    this.load()
  }

  freezePlan(plan: VerificationPlan): VerificationPlan {
    const frozen: VerificationPlan = {
      workItemId: plan.workItemId,
      requireSemantic: plan.requireSemantic,
      checks: plan.checks.map((check) => ({ ...check, args: [...check.args] })),
    }
    this.plans.set(plan.workItemId, frozen)
    this.save()
    return frozen
  }

  get(workItemId: string): VerificationPlan | undefined {
    return this.plans.get(workItemId)
  }

  addSafetyCheck(workItemId: string, check: VerificationCheck): VerificationPlan {
    const current = this.plans.get(workItemId)
    if (!current) {
      throw new Error("Verification Plan missing")
    }
    const next = this.freezePlan({
      ...current,
      checks: [...current.checks, check],
    })
    return next
  }

  setBaseline(checkId: string, code: number): void {
    this.baseline.set(checkId, code)
    this.save()
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) {
      return
    }
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, "utf8")) as {
        plans?: VerificationPlan[]
        baseline?: Array<[string, number]>
      }
      for (const plan of raw.plans ?? []) {
        this.plans.set(plan.workItemId, plan)
      }
      for (const [id, code] of raw.baseline ?? []) {
        this.baseline.set(id, code)
      }
    } catch {
      // catalog is a cache; a corrupt file must not block the Supervisor
    }
  }

  private save(): void {
    if (!this.persistPath) {
      return
    }
    mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 })
    writeFileSync(
      this.persistPath,
      JSON.stringify({
        plans: [...this.plans.values()],
        baseline: [...this.baseline.entries()],
      }),
      { encoding: "utf8", mode: 0o600 },
    )
  }

  baselineCode(checkId: string): number | undefined {
    return this.baseline.get(checkId)
  }
}

export function createDefaultPlan(workItem: WorkItemRecord): VerificationPlan {
  return {
    workItemId: workItem.id,
    requireSemantic: false,
    checks: [
      {
        id: "tests",
        command: "bun",
        args: ["test"],
        timeoutMs: 120_000,
        cwd: "worktree",
        expectedExitCode: 0,
      },
      {
        id: "tests-integration",
        command: "bun",
        args: ["test"],
        timeoutMs: 120_000,
        cwd: "integration",
        expectedExitCode: 0,
      },
    ],
  }
}

export class VerificationEngine {
  constructor(
    private readonly store: AutopilotStore,
    private readonly catalog: VerificationCatalog,
    private readonly process: ProcessPort,
    private readonly git: GitPort,
    private readonly semantic?: SemanticEngine,
  ) {}

  async verifyAndIntegrate(input: {
    runId: string
    fencingToken: number
    workItemId: string
    worktree: string
    integrationCwd: string
    baseRevision: string
    wholeRepositoryHealth?: boolean
  }): Promise<VerificationResult> {
    const item = this.store.getWorkItem(input.workItemId)
    if (!item || item.status !== "verifying") {
      throw new Error("Work Item is not verifying")
    }
    const plan = this.catalog.get(item.id) ?? this.catalog.freezePlan(createDefaultPlan(item))
    const worktreeResult = await this.runChecks(plan, "worktree", input.worktree, input.wholeRepositoryHealth === true)
    if (!worktreeResult.success) {
      this.fail(input.runId, input.fencingToken, item, worktreeResult)
      return worktreeResult
    }
    if (plan.requireSemantic && this.semantic) {
      const semantic = await runValidated(
        this.semantic,
        {
          operation: "verify-acceptance",
          workItem: { id: item.id, title: item.title, objective: item.objective },
          observations: { checks: "passed" },
        },
        2,
      )
      if (semantic.operation === "verify-acceptance" && !semantic.accepted) {
        const result: VerificationResult = {
          success: false,
          checks: worktreeResult.checks,
          reason: semantic.reason ?? "semantic acceptance failed",
          ...(semantic.reason ? { suggestedRepair: semantic.reason } : {}),
        }
        this.fail(input.runId, input.fencingToken, item, result)
        return result
      }
    }
    if (!this.git.available()) {
      this.store.mutate(input.runId, input.fencingToken, (tx) => {
        tx.transitionWorkItem(item.id, "integrating", "non-git snapshot")
        tx.transitionWorkItem(item.id, "completed", "verified snapshot")
      })
      return worktreeResult
    }
    if (!input.baseRevision) {
      const result: VerificationResult = {
        success: false,
        checks: worktreeResult.checks,
        reason: "missing base SHA",
        suggestedRepair: "Persist the Work Item worktree base SHA before verification.",
      }
      this.fail(input.runId, input.fencingToken, item, result)
      return result
    }
    this.store.mutate(input.runId, input.fencingToken, (tx) => {
      tx.transitionWorkItem(item.id, "integrating", "checks passed")
    })
    const commits = this.git.commitsSince(input.baseRevision, input.worktree)
    if (commits.length === 0) {
      const result: VerificationResult = {
        success: false,
        checks: worktreeResult.checks,
        reason: "Worker produced no commits",
        suggestedRepair: "Commit the implementation in the Work Item worktree.",
      }
      this.fail(input.runId, input.fencingToken, item, result, "integrating")
      return result
    }
    const beforeSha = this.git.head(input.integrationCwd)
    try {
      this.git.cherryPick(commits, input.integrationCwd)
    } catch {
      const result: VerificationResult = {
        success: false,
        checks: worktreeResult.checks,
        reason: "integration conflict",
        suggestedRepair: "Rebase onto the current Run Branch and resolve conflicts.",
      }
      this.git.revertCherryPick(input.integrationCwd)
      this.fail(input.runId, input.fencingToken, item, result, "integrating")
      return result
    }
    const integrationResult = await this.runChecks(
      plan,
      "integration",
      input.integrationCwd,
      input.wholeRepositoryHealth === true,
    )
    if (!integrationResult.success) {
      this.git.revertCherryPick(input.integrationCwd, beforeSha)
      this.fail(input.runId, input.fencingToken, item, integrationResult, "integrating")
      return integrationResult
    }
    this.store.mutate(input.runId, input.fencingToken, (tx) => {
      tx.transitionWorkItem(item.id, "completed", "integrated")
    })
    return { success: true, checks: [...worktreeResult.checks, ...integrationResult.checks] }
  }

  repairPrompt(result: VerificationResult): string {
    return [
      "Previous implementation failed verification.",
      result.reason ? `Failure: ${result.reason}` : "",
      ...result.checks
        .filter((check) => !check.success)
        .map((check) => `${check.id} exited ${check.code}: ${check.output}`),
      result.suggestedRepair ?? "Inspect the existing implementation and fix the failing checks.",
      "Do not redo unrelated work.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  private async runChecks(
    plan: VerificationPlan,
    cwdKind: VerificationCheck["cwd"],
    cwd: string,
    wholeRepositoryHealth: boolean,
  ): Promise<VerificationResult> {
    const checks: VerificationCheckResult[] = []
    for (const check of plan.checks.filter((entry) => entry.cwd === cwdKind)) {
      const executed = await this.process.run({
        command: check.command,
        args: check.args,
        cwd,
        timeoutMs: check.timeoutMs,
      })
      const output = redact(`${executed.stdout}\n${executed.stderr}`.trim()).slice(0, 4000)
      const baseline = this.catalog.baselineCode(check.id)
      const success = executed.code === check.expectedExitCode
      const baselineFailure = baseline !== undefined && baseline !== check.expectedExitCode
      const counts =
        success || (baselineFailure && !wholeRepositoryHealth && executed.code === baseline)
      checks.push({
        id: check.id,
        success: counts,
        code: executed.code,
        output,
        baselineFailure,
      })
    }
    const failed = checks.filter((check) => !check.success)
    return {
      success: failed.length === 0,
      checks,
      ...(failed[0]
        ? {
            reason: `${failed[0].id} failed`,
            suggestedRepair: `Fix ${failed[0].id} and rerun it before declaring completion.`,
          }
        : {}),
    }
  }

  private fail(
    runId: string,
    fencingToken: number,
    item: WorkItemRecord,
    result: VerificationResult,
    from: "verifying" | "integrating" = "verifying",
  ): void {
    const max = this.store.getRun(runId)?.maxRetriesPerWorkItem ?? 3
    this.store.mutate(runId, fencingToken, (tx) => {
      const current = tx.getWorkItem(item.id)
      if (current.status !== from) {
        return
      }
      tx.incrementFailedAttempts(item.id, 1)
      const attempts = tx.getWorkItem(item.id).failedAttempts
      const reason = result.reason ?? "verification failed"
      if (attempts >= max) {
        if (from === "integrating") {
          tx.transitionWorkItem(item.id, "repairing", reason)
        }
        tx.transitionWorkItem(item.id, "stuck", reason)
        return
      }
      tx.transitionWorkItem(item.id, "repairing", reason)
    })
  }
}

function redact(value: string): string {
  return value.replace(/(token|secret|password|key)=([^\s]+)/gi, "$1=redacted")
}
