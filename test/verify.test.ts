import { describe, expect, test } from "bun:test"

import { AutopilotStore } from "../src/core/store.js"
import { ScriptedSemanticEngine } from "../src/planning/scripted-engine.js"
import { createDefaultPlan, VerificationCatalog, VerificationEngine } from "../src/verify/engine.js"
import { FakeGitPort } from "../src/verify/git.js"
import { FakeProcessPort } from "../src/verify/process.js"

const TTL = 60_000

function verifyingItem() {
  const store = AutopilotStore.memory()
  const run = store.createRun({
    canonicalRoot: "/repo",
    objective: "Fix tests.",
    maxRetriesPerWorkItem: 3,
  })
  const lease = store.acquireLease(run.id, "instance-a", TTL)
  const item = store.mutate(run.id, lease.fencingToken, (tx) => {
    const created = tx.upsertWorkItem({
      title: "Fix tests",
      objective: "Fix tests",
      sourceKey: "check:tests",
    })
    tx.transitionWorkItem(created.id, "ready", "unblocked")
    tx.transitionWorkItem(created.id, "launching", "schedule")
    tx.transitionWorkItem(created.id, "running", "session attached")
    return tx.transitionWorkItem(created.id, "verifying", "idle")
  })
  return { store, run, lease, item }
}

describe("verification and integration", () => {
  test("default Verification Plan includes integration-cwd checks", () => {
    const plan = createDefaultPlan({
      id: "w1",
      runId: "r1",
      title: "Fix tests",
      objective: "Fix tests",
      status: "verifying",
      dependencies: [],
      failedAttempts: 0,
      createdAt: 0,
      updatedAt: 0,
    })
    expect(plan.checks.some((check) => check.cwd === "integration")).toBe(true)
    expect(plan.checks.some((check) => check.cwd === "worktree")).toBe(true)
  })

  test("commitsSince uses the persisted worktree base SHA, not HEAD..HEAD", async () => {
    const { store, run, lease, item } = verifyingItem()
    const git = new FakeGitPort()
    const engine = new VerificationEngine(store, new VerificationCatalog(), new FakeProcessPort(), git)
    await engine.verifyAndIntegrate({
      runId: run.id,
      fencingToken: lease.fencingToken,
      workItemId: item.id,
      worktree: "/tmp/work",
      integrationCwd: "/tmp/integration",
      baseRevision: "abcdef",
    })
    expect(git.lastRange).toEqual({ base: "abcdef", cwd: "/tmp/work" })
  })

  test("persists the Verification Catalog next to sqlite", () => {
    const path = `/tmp/autopilot-catalog-${crypto.randomUUID()}.json`
    const first = new VerificationCatalog(path)
    first.freezePlan({
      workItemId: "w1",
      requireSemantic: false,
      checks: [
        {
          id: "tests",
          command: "bun",
          args: ["test"],
          timeoutMs: 1000,
          cwd: "worktree",
          expectedExitCode: 0,
        },
      ],
    })
    const second = new VerificationCatalog(path)
    expect(second.get("w1")?.checks[0]?.id).toBe("tests")
  })

  test("completes after passing worktree checks, Worker commits, and integration", async () => {
    const { store, run, lease, item } = verifyingItem()
    const catalog = new VerificationCatalog()
    catalog.freezePlan({
      workItemId: item.id,
      requireSemantic: false,
      checks: [
        {
          id: "tests",
          command: "bun",
          args: ["test"],
          timeoutMs: 1000,
          cwd: "worktree",
          expectedExitCode: 0,
        },
        {
          id: "tests-integration",
          command: "bun",
          args: ["test"],
          timeoutMs: 1000,
          cwd: "integration",
          expectedExitCode: 0,
        },
      ],
    })
    const engine = new VerificationEngine(
      store,
      catalog,
      new FakeProcessPort(),
      new FakeGitPort(),
    )
    const result = await engine.verifyAndIntegrate({
      runId: run.id,
      fencingToken: lease.fencingToken,
      workItemId: item.id,
      worktree: "/tmp/work",
      integrationCwd: "/tmp/integration",
      baseRevision: "base",
    })
    expect(result.success).toBe(true)
    expect(store.getWorkItem(item.id)?.status).toBe("completed")
  })

  test("does not complete from Worker idle without passing checks", async () => {
    const { store, run, lease, item } = verifyingItem()
    const catalog = new VerificationCatalog()
    catalog.freezePlan({
      workItemId: item.id,
      requireSemantic: false,
      checks: [
        {
          id: "tests",
          command: "bun",
          args: ["test"],
          timeoutMs: 1000,
          cwd: "worktree",
          expectedExitCode: 0,
        },
      ],
    })
    const process = new FakeProcessPort({ bun: 1 })
    const engine = new VerificationEngine(store, catalog, process, new FakeGitPort())
    const result = await engine.verifyAndIntegrate({
      runId: run.id,
      fencingToken: lease.fencingToken,
      workItemId: item.id,
      worktree: "/tmp/work",
      integrationCwd: "/tmp/integration",
      baseRevision: "base",
    })
    expect(result.success).toBe(false)
    expect(store.getWorkItem(item.id)?.status).toBe("repairing")
    expect(engine.repairPrompt(result)).toContain("Fix tests")
  })

  test("reverts integration conflicts and keeps the Work Item out of completed", async () => {
    const { store, run, lease, item } = verifyingItem()
    const git = new FakeGitPort()
    git.cherryPickShouldFail = true
    const engine = new VerificationEngine(
      store,
      new VerificationCatalog(),
      new FakeProcessPort(),
      git,
    )
    const result = await engine.verifyAndIntegrate({
      runId: run.id,
      fencingToken: lease.fencingToken,
      workItemId: item.id,
      worktree: "/tmp/work",
      integrationCwd: "/tmp/integration",
      baseRevision: "base",
    })
    expect(result.reason).toBe("integration conflict")
    expect(git.reverted).toBe(true)
    expect(store.getWorkItem(item.id)?.status).toBe("repairing")
  })

  test("ignores unchanged baseline failures unless whole-repository health is required", async () => {
    const { store, run, lease, item } = verifyingItem()
    const catalog = new VerificationCatalog()
    catalog.setBaseline("tests", 1)
    catalog.freezePlan({
      workItemId: item.id,
      requireSemantic: false,
      checks: [
        {
          id: "tests",
          command: "bun",
          args: ["test"],
          timeoutMs: 1000,
          cwd: "worktree",
          expectedExitCode: 0,
        },
      ],
    })
    const engine = new VerificationEngine(
      store,
      catalog,
      new FakeProcessPort({ bun: 1 }),
      new FakeGitPort(),
    )
    const result = await engine.verifyAndIntegrate({
      runId: run.id,
      fencingToken: lease.fencingToken,
      workItemId: item.id,
      worktree: "/tmp/work",
      integrationCwd: "/tmp/integration",
      baseRevision: "base",
    })
    expect(result.success).toBe(true)
    expect(store.getWorkItem(item.id)?.status).toBe("completed")
  })

  test("marks a Work Item stuck after three implementation failures", async () => {
    const { store, run, lease, item } = verifyingItem()
    store.mutate(run.id, lease.fencingToken, (tx) => {
      tx.incrementFailedAttempts(item.id, 2)
    })
    const catalog = new VerificationCatalog()
    catalog.freezePlan({
      workItemId: item.id,
      requireSemantic: false,
      checks: [
        {
          id: "tests",
          command: "bun",
          args: ["test"],
          timeoutMs: 1000,
          cwd: "worktree",
          expectedExitCode: 0,
        },
      ],
    })
    const engine = new VerificationEngine(
      store,
      catalog,
      new FakeProcessPort({ bun: 1 }),
      new FakeGitPort(),
    )
    await engine.verifyAndIntegrate({
      runId: run.id,
      fencingToken: lease.fencingToken,
      workItemId: item.id,
      worktree: "/tmp/work",
      integrationCwd: "/tmp/integration",
      baseRevision: "base",
    })
    expect(store.getWorkItem(item.id)?.status).toBe("stuck")
  })

  test("semantic acceptance cannot waive a deterministic failure", async () => {
    const { store, run, lease, item } = verifyingItem()
    const catalog = new VerificationCatalog()
    catalog.freezePlan({
      workItemId: item.id,
      requireSemantic: true,
      checks: [
        {
          id: "tests",
          command: "bun",
          args: ["test"],
          timeoutMs: 1000,
          cwd: "worktree",
          expectedExitCode: 0,
        },
      ],
    })
    const engine = new VerificationEngine(
      store,
      catalog,
      new FakeProcessPort({ bun: 1 }),
      new FakeGitPort(),
      new ScriptedSemanticEngine({
        "verify-acceptance": {
          operation: "verify-acceptance",
          accepted: true,
        },
      }),
    )
    const result = await engine.verifyAndIntegrate({
      runId: run.id,
      fencingToken: lease.fencingToken,
      workItemId: item.id,
      worktree: "/tmp/work",
      integrationCwd: "/tmp/integration",
      baseRevision: "base",
    })
    expect(result.success).toBe(false)
    expect(store.getWorkItem(item.id)?.status).toBe("repairing")
  })
})
