import { describe, expect, test } from "bun:test"

import { AutopilotStore } from "../src/core/store.js"
import { InMemoryWorktreePort, WorkerLifecycle } from "../src/workers/lifecycle.js"
import { FakeSessionRunner } from "../src/workers/session-runner.js"

const TTL = 60_000

function setup() {
  const store = AutopilotStore.memory()
  const run = store.createRun({
    canonicalRoot: "/repo",
    objective: "Implement ready Work Items.",
    concurrency: 2,
  })
  const lease = store.acquireLease(run.id, "instance-a", TTL)
  const runner = new FakeSessionRunner()
  const worktrees = new InMemoryWorktreePort()
  const lifecycle = new WorkerLifecycle(store, runner, worktrees)
  return { store, run, lease, runner, worktrees, lifecycle }
}

function readyItem(
  store: AutopilotStore,
  runId: string,
  token: number,
  input: { title: string; sourceKey: string; dependencies?: string[] },
) {
  return store.mutate(runId, token, (tx) => {
    const item = tx.upsertWorkItem({
      title: input.title,
      objective: input.title,
      sourceKey: input.sourceKey,
      dependencies: input.dependencies ?? [],
    })
    return tx.transitionWorkItem(item.id, "ready", "unblocked")
  })
}

describe("Worker lifecycle", () => {
  test("persists launch identity and worktree reservation before creating a session", async () => {
    const { store, run, lease, runner, worktrees, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    runner.onCreate = () => {
      expect(store.getWorkItem(item.id)?.status).toBe("launching")
      expect(store.snapshot(run.id).attempts).toHaveLength(1)
      expect(store.snapshot(run.id).worktrees).toHaveLength(1)
      expect(worktrees.reserved).toHaveLength(1)
    }
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    expect(runner.createCalls).toBe(1)
    expect(store.getWorkItem(item.id)?.status).toBe("running")
    expect(runner.prompted[0]?.instruction.prompt).toBe("Implement pagination.")
  })

  test("respects concurrency and dependency gates", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    readyItem(store, run.id, lease.fencingToken, {
      title: "First",
      sourceKey: "one",
    })
    readyItem(store, run.id, lease.fencingToken, {
      title: "Second",
      sourceKey: "two",
    })
    readyItem(store, run.id, lease.fencingToken, {
      title: "Third",
      sourceKey: "three",
    })
    readyItem(store, run.id, lease.fencingToken, {
      title: "Blocked",
      sourceKey: "blocked",
      dependencies: ["missing"],
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: (item) => ({ prompt: item.title }),
    })
    expect(runner.createCalls).toBe(2)
    const running = store.snapshot(run.id).workItems.filter((item) => item.status === "running")
    expect(running).toHaveLength(2)
    expect(store.snapshot(run.id).workItems.find((item) => item.sourceKey === "blocked")?.status).toBe(
      "ready",
    )
  })

  test("serializes known overlapping file scopes", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const first = readyItem(store, run.id, lease.fencingToken, {
      title: "First",
      sourceKey: "one",
    })
    const second = readyItem(store, run.id, lease.fencingToken, {
      title: "Second",
      sourceKey: "two",
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: (item) => ({ prompt: item.title }),
      fileScopes: new Map([
        [first.id, ["src/search.ts"]],
        [second.id, ["src/search.ts"]],
      ]),
    })
    expect(runner.createCalls).toBe(1)
  })

  test("treats session idle as candidate verification, not completion", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: lease.fencingToken,
      sessionId: runner.created[0]?.id ?? "",
      kind: "idle",
    })
    expect(store.getWorkItem(item.id)?.status).toBe("verifying")
  })

  test("aborts an active Worker session", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    const sessionId = runner.created[0]?.id ?? ""
    await lifecycle.abortSession({
      runId: run.id,
      fencingToken: lease.fencingToken,
      sessionId,
    })
    expect(runner.aborted).toEqual([sessionId])
    expect(store.getWorkItem(item.id)?.status).toBe("repairing")
  })

  test("recovers launch identities from session titles after restart", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    const launchToken = "launch-recover"
    store.mutate(run.id, lease.fencingToken, (tx) => {
      tx.transitionWorkItem(item.id, "launching", "schedule")
      tx.beginWorkerAttempt({ workItemId: item.id, launchToken })
    })
    runner.created.push({
      id: "ses_recovered",
      title: `autopilot run=${run.id} work=${item.id} launch=${launchToken}`,
    })
    await lifecycle.recover({ runId: run.id, fencingToken: lease.fencingToken })
    expect(store.getWorkItem(item.id)?.status).toBe("running")
    expect(store.findAttemptByLaunchToken(launchToken)?.sessionId).toBe("ses_recovered")
  })

  test("repair relaunch reuses the existing worktree reservation", async () => {
    const { store, run, lease, runner, worktrees, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    store.mutate(run.id, lease.fencingToken, (tx) => {
      tx.reserveWorktree(item.id, `.autopilot/worktrees/${item.id}`, `autopilot/${item.id}`, "abc")
      tx.transitionWorkItem(item.id, "launching", "schedule")
      tx.transitionWorkItem(item.id, "running", "session attached")
      tx.transitionWorkItem(item.id, "verifying", "idle")
      tx.transitionWorkItem(item.id, "repairing", "checks failed")
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: () => ({ prompt: "Repair pagination." }),
    })
    expect(worktrees.reserved).toHaveLength(1)
    expect(worktrees.reserved[0]?.path).toBe(`.autopilot/worktrees/${item.id}`)
    expect(store.snapshot(run.id).worktrees).toHaveLength(1)
    expect(runner.createCalls).toBe(1)
  })

  test("session error fails a verifying Work Item", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: lease.fencingToken,
      sessionId: runner.created[0]?.id ?? "",
      kind: "idle",
    })
    expect(store.getWorkItem(item.id)?.status).toBe("verifying")
    lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: lease.fencingToken,
      sessionId: runner.created[0]?.id ?? "",
      kind: "error",
    })
    expect(store.getWorkItem(item.id)?.status).toBe("repairing")
  })

  test("session abort fails a verifying Work Item", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: lease.fencingToken,
      sessionId: runner.created[0]?.id ?? "",
      kind: "idle",
    })
    lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: lease.fencingToken,
      sessionId: runner.created[0]?.id ?? "",
      kind: "abort",
    })
    expect(store.getWorkItem(item.id)?.status).toBe("repairing")
  })

  test("session error records unknown via the idle path", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: lease.fencingToken,
      sessionId: runner.created[0]?.id ?? "",
      kind: "error",
    })
    expect(store.getWorkItem(item.id)?.status).toBe("repairing")
  })

  test("unknown Work Items with retries remaining become repairing", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: lease.fencingToken,
      sessionId: runner.created[0]?.id ?? "",
      kind: "error",
    })
    expect(store.getWorkItem(item.id)?.status).toBe("repairing")
    expect((store.getWorkItem(item.id)?.failedAttempts ?? 0) > 0).toBe(true)
  })

  test("unknown Work Items become stuck after maxRetries", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    store.mutate(run.id, lease.fencingToken, (tx) => {
      tx.incrementFailedAttempts(item.id, 2)
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    lifecycle.handleSessionEvent({
      runId: run.id,
      fencingToken: lease.fencingToken,
      sessionId: runner.created[0]?.id ?? "",
      kind: "error",
    })
    expect(store.getWorkItem(item.id)?.status).toBe("stuck")
  })

  test("Worker worktrees start from the Run Branch worktree", async () => {
    const { store, run, lease, worktrees, lifecycle } = setup()
    readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    const startPoint = `/repo/.autopilot/runs/${run.id}`
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      canonicalRoot: "/repo",
      startPoint,
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    expect(worktrees.reserved[0]?.startPoint).toBe(startPoint)
    expect(worktrees.reserved[0]?.path.startsWith("/")).toBe(true)
  })

  test("repair reuses a relative worktree reservation without colliding", async () => {
    const { store, run, lease, runner, lifecycle } = setup()
    const item = readyItem(store, run.id, lease.fencingToken, {
      title: "Add pagination",
      sourceKey: "github:231",
    })
    const storedPath = `.autopilot/worktrees/${item.id}`
    store.mutate(run.id, lease.fencingToken, (tx) => {
      tx.reserveWorktree(item.id, storedPath, `autopilot/${item.id}`)
    })
    await lifecycle.fillSlots({
      runId: run.id,
      fencingToken: lease.fencingToken,
      canonicalRoot: "/repo",
      instructionFor: () => ({ prompt: "Implement pagination." }),
    })
    expect(runner.createCalls).toBe(1)
    expect(store.snapshot(run.id).worktrees[0]?.path).toBe(storedPath)
  })
})
