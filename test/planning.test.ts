import { describe, expect, test } from "bun:test"

import { AutopilotStore } from "../src/core/store.js"
import { buildCapabilitySnapshot } from "../src/planning/capabilities.js"
import { compileWorkerInstruction } from "../src/planning/compiler.js"
import { discoverEvidence } from "../src/planning/discover.js"
import { selectWorkSourcesFromObjective } from "../src/planning/interpret.js"
import { applyPlan, applyPlanFromEngine, unblockReadyWorkItems } from "../src/planning/planner.js"
import { ScriptedSemanticEngine } from "../src/planning/scripted-engine.js"
import { SemanticValidationError } from "../src/planning/semantic-engine.js"
import { DirectObjectiveSource, WorkSourceRegistry } from "../src/planning/sources.js"

const TTL = 60_000

function openRun() {
  const store = AutopilotStore.memory()
  const run = store.createRun({
    canonicalRoot: "/repo",
    objective: "Fix the failing authentication tests.",
  })
  const lease = store.acquireLease(run.id, "instance-a", TTL)
  return { store, run, lease }
}

describe("discovery", () => {
  test("runs only Work Sources selected by objective interpretation", async () => {
    const registry = new WorkSourceRegistry()
    const scanned: string[] = []
    registry.register(new DirectObjectiveSource())
    registry.register({
      id: "github-issues",
      async discover() {
        scanned.push("github-issues")
        return []
      },
    })
    const engine = new ScriptedSemanticEngine({
      "interpret-objective": {
        operation: "interpret-objective",
        sources: [
          {
            id: "direct-objective",
            rank: 1,
            reason: "objective names failing tests",
            hints: { focus: "authentication" },
          },
        ],
      },
    })
    const evidence = await discoverEvidence({
      objective: "Fix the failing authentication tests.",
      engine,
      registry,
    })
    expect(scanned).toEqual([])
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.sourceId).toBe("direct-objective")
    expect(evidence[0]?.sourceKey).toBe("direct-objective:Fix the failing authentication tests.")
    expect(evidence[0]?.fingerprint.length).toBeGreaterThan(0)
  })
})

describe("objective interpretation heuristics", () => {
  test("Work through GitHub issues selects github-issues", () => {
    const ids = selectWorkSourcesFromObjective("Work through GitHub issues").map((source) => source.id)
    expect(ids).toContain("github-issues")
    expect(ids).toContain("direct-objective")
  })
})

describe("plan reconciliation", () => {
  test("applies a valid proposal without launching Workers", () => {
    const { store, run, lease } = openRun()
    const applied = applyPlan({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
      proposal: {
        operation: "propose-plan",
        items: [
          {
            sourceKey: "check:auth",
            title: "Fix authentication tests",
            objective: "Make authentication integration tests pass.",
            dependencies: [],
          },
        ],
      },
    })
    expect(applied).toHaveLength(1)
    expect(applied[0]?.status).toBe("ready")
    expect(store.snapshot(run.id).attempts).toEqual([])
  })

  test("rejects dependency cycles", () => {
    const { store, run, lease } = openRun()
    expect(() =>
      applyPlan({
        store,
        runId: run.id,
        fencingToken: lease.fencingToken,
        proposal: {
          operation: "propose-plan",
          items: [
            {
              sourceKey: "a",
              title: "A",
              objective: "A",
              dependencies: ["b"],
            },
            {
              sourceKey: "b",
              title: "B",
              objective: "B",
              dependencies: ["a"],
            },
          ],
        },
      }),
    ).toThrow("dependency cycle")
  })

  test("does not reset retries or rewrite running Work Items", () => {
    const { store, run, lease } = openRun()
    const running = store.mutate(run.id, lease.fencingToken, (tx) => {
      const item = tx.upsertWorkItem({
        title: "Fix authentication tests",
        objective: "original",
        sourceKey: "check:auth",
      })
      tx.transitionWorkItem(item.id, "ready", "unblocked")
      tx.transitionWorkItem(item.id, "launching", "schedule")
      tx.transitionWorkItem(item.id, "running", "session attached")
      tx.incrementFailedAttempts(item.id, 2)
      return item.id
    })
    applyPlan({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
      proposal: {
        operation: "propose-plan",
        items: [
          {
            sourceKey: "check:auth",
            title: "rewritten",
            objective: "should not replace running work",
            dependencies: [],
          },
        ],
      },
    })
    const item = store.getWorkItem(running)
    expect(item?.title).toBe("Fix authentication tests")
    expect(item?.status).toBe("running")
    expect(item?.failedAttempts).toBe(2)
  })

  test("does not reopen a completed Work Item when the fingerprint is unchanged", () => {
    const { store, run, lease } = openRun()
    store.mutate(run.id, lease.fencingToken, (tx) => {
      const item = tx.upsertWorkItem({
        title: "Fix authentication tests",
        objective: "original",
        sourceKey: "check:auth",
        contentFingerprint: "fp-1",
      })
      tx.transitionWorkItem(item.id, "ready", "unblocked")
      tx.transitionWorkItem(item.id, "launching", "schedule")
      tx.transitionWorkItem(item.id, "running", "session attached")
      tx.transitionWorkItem(item.id, "verifying", "idle")
      tx.transitionWorkItem(item.id, "integrating", "checks passed")
      tx.transitionWorkItem(item.id, "completed", "integrated")
    })
    const applied = applyPlan({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
      proposal: {
        operation: "propose-plan",
        items: [
          {
            sourceKey: "check:auth",
            title: "Fix authentication tests",
            objective: "original",
            dependencies: [],
            contentFingerprint: "fp-1",
          },
        ],
      },
    })
    expect(applied[0]?.status).toBe("completed")
    expect(store.snapshot(run.id).workItems).toHaveLength(1)
  })

  test("blocked Work Items with empty dependencies become ready", () => {
    const { store, run, lease } = openRun()
    applyPlan({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
      proposal: {
        operation: "propose-plan",
        items: [
          {
            sourceKey: "orphan-blocked",
            title: "Orphan",
            objective: "Should unblock.",
            dependencies: [],
            blocked: true,
            blockedReason: "stale block",
          },
        ],
      },
    })
    expect(store.snapshot(run.id).workItems[0]?.status).toBe("blocked")
    unblockReadyWorkItems({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
    })
    expect(store.snapshot(run.id).workItems[0]?.status).toBe("ready")
  })

  test("diagnostic semantic-plan Work Items stay blocked", () => {
    const { store, run, lease } = openRun()
    applyPlan({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
      proposal: {
        operation: "propose-plan",
        items: [
          {
            sourceKey: "diagnostic:semantic-plan",
            title: "Clarify Autopilot Objective",
            objective: "Semantic planning failed validation. Supervisor remains enabled.",
            dependencies: [],
            blocked: true,
            blockedReason: "invalid semantic output",
          },
        ],
      },
    })
    unblockReadyWorkItems({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
    })
    expect(store.snapshot(run.id).workItems[0]?.status).toBe("blocked")
  })

  test("blocked Work Items become ready when every dependency is completed", () => {
    const { store, run, lease } = openRun()
    applyPlan({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
      proposal: {
        operation: "propose-plan",
        items: [
          {
            sourceKey: "dep-a",
            title: "Dependency A",
            objective: "Finish A.",
            dependencies: [],
          },
          {
            sourceKey: "blocked-child",
            title: "Child",
            objective: "Wait for A.",
            dependencies: ["dep-a"],
            blocked: true,
            blockedReason: "waiting on dep-a",
          },
        ],
      },
    })
    const parent = store.snapshot(run.id).workItems.find((item) => item.sourceKey === "dep-a")
    expect(parent).toBeDefined()
    store.mutate(run.id, lease.fencingToken, (tx) => {
      tx.transitionWorkItem(parent!.id, "launching", "schedule")
      tx.transitionWorkItem(parent!.id, "running", "session attached")
      tx.transitionWorkItem(parent!.id, "verifying", "idle")
      tx.transitionWorkItem(parent!.id, "integrating", "checks passed")
      tx.transitionWorkItem(parent!.id, "completed", "integrated")
    })
    unblockReadyWorkItems({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
    })
    expect(store.snapshot(run.id).workItems.find((item) => item.sourceKey === "blocked-child")?.status).toBe(
      "ready",
    )
  })

  test("records a blocked diagnostic Work Item after invalid semantic output is retried", async () => {
    const { store, run, lease } = openRun()
    let calls = 0
    const engine = new ScriptedSemanticEngine({
      "propose-plan": () => {
        calls += 1
        throw new SemanticValidationError("missing items")
      },
    })
    const items = await applyPlanFromEngine({
      store,
      runId: run.id,
      fencingToken: lease.fencingToken,
      engine,
      objective: "Fix the failing authentication tests.",
      evidence: [],
      prior: [],
      retryLimit: 2,
    })
    expect(calls).toBe(2)
    expect(items[0]?.sourceKey).toBe("diagnostic:semantic-plan")
    expect(items[0]?.status).toBe("blocked")
  })
})

describe("Worker Instruction compiler", () => {
  test("uses a specialized Capability only with explicit fit evidence", async () => {
    const snapshot = buildCapabilitySnapshot({
      commands: [
        {
          id: "fix-tests",
          description: "Fix failing tests in a named area",
          provenance: "config.command",
          invocation: { kind: "command", template: "/fix-tests $ARGUMENTS" },
        },
      ],
      skills: [],
      agents: [],
      tools: [],
      mcp: [],
      repository: [],
    })
    const engine = new ScriptedSemanticEngine({
      "compile-instruction": {
        operation: "compile-instruction",
        instruction: {
          command: "/fix-tests authentication",
          capabilityId: "fix-tests",
          fitEvidence: "objective names failing authentication tests and command description matches",
        },
      },
    })
    const compiled = await compileWorkerInstruction({
      engine,
      objective: "Fix the failing authentication tests.",
      workItem: {
        id: "w1",
        title: "Fix authentication tests",
        objective: "Make authentication integration tests pass.",
      },
      capabilities: snapshot,
    })
    expect(compiled.command).toBe("/fix-tests authentication")
  })

  test("falls back to a raw prompt when fit evidence is missing", async () => {
    const snapshot = buildCapabilitySnapshot({
      commands: [
        {
          id: "fix-tests",
          description: "Fix failing tests",
          provenance: "config.command",
          invocation: { kind: "command", template: "/fix-tests $ARGUMENTS" },
        },
      ],
      skills: [],
      agents: [],
      tools: [],
      mcp: [],
      repository: [],
    })
    const engine = new ScriptedSemanticEngine({
      "compile-instruction": {
        operation: "compile-instruction",
        instruction: {
          command: "/fix-tests authentication",
          capabilityId: "fix-tests",
        },
      },
    })
    const compiled = await compileWorkerInstruction({
      engine,
      objective: "Fix the failing authentication tests.",
      workItem: {
        id: "w1",
        title: "Fix authentication tests",
        objective: "Make authentication integration tests pass.",
      },
      capabilities: snapshot,
    })
    expect(compiled.command).toBeUndefined()
    expect(compiled.prompt).toContain("Make authentication integration tests pass.")
  })
})
