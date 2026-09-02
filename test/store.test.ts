import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AutopilotStore,
  StaleLeaseError,
  TransitionError,
} from "../src/core/store.js"
import { SqliteDriver } from "../src/core/sqlite-driver.js"

const TTL = 60_000

function createClock(start = 1_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function withStore(
  name: string,
  factory: (clock: ReturnType<typeof createClock>) => AutopilotStore,
) {
  describe(name, () => {
    const clock = createClock()
    let store: AutopilotStore

    const open = () => {
      store = factory(clock)
      return store
    }

    afterEach(() => {
      store.close()
    })

    test("persists an Autopilot Objective with the run enabled", () => {
      const created = open().createRun({
        canonicalRoot: "/repo",
        objective: "Implement all actionable GitHub issues.",
      })
      const loaded = store.getActiveRun("/repo")
      expect(loaded?.id).toBe(created.id)
      expect(loaded?.objective).toBe("Implement all actionable GitHub issues.")
      expect(loaded?.status).toBe("enabled")
    })

    test("rejects a second active Autopilot Run for the same root", () => {
      open().createRun({
        canonicalRoot: "/repo",
        objective: "first",
      })
      expect(() =>
        store.createRun({
          canonicalRoot: "/repo",
          objective: "second",
        }),
      ).toThrow("active Autopilot Run already exists")
    })

    test("allows a new Autopilot Run after the previous one is stopped", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "first",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      store.mutate(run.id, lease.fencingToken, (tx) => {
        tx.setRunStatus("stopping", "graceful stop")
        tx.setRunStatus("stopped", "drained")
      })
      const next = store.createRun({
        canonicalRoot: "/repo",
        objective: "second",
      })
      expect(next.objective).toBe("second")
      expect(store.getActiveRun("/repo")?.id).toBe(next.id)
    })

    test("rejects mutations with a stale fencing token", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const first = store.acquireLease(run.id, "instance-a", TTL)
      clock.advance(TTL + 1)
      const second = store.acquireLease(run.id, "instance-b", TTL)
      expect(second.fencingToken).toBe(first.fencingToken + 1)
      expect(() =>
        store.mutate(run.id, first.fencingToken, (tx) => {
          tx.setRunStatus("paused", "should not apply")
        }),
      ).toThrow(StaleLeaseError)
      expect(store.getRun(run.id)?.status).toBe("enabled")
    })

    test("lets the current owner renew without changing the fencing token", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const first = store.acquireLease(run.id, "instance-a", TTL)
      const renewed = store.renewLease(run.id, "instance-a", first.fencingToken, TTL)
      expect(renewed.fencingToken).toBe(first.fencingToken)
    })

    test("records Work Item transitions and history", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      const item = store.mutate(run.id, lease.fencingToken, (tx) => {
        const created = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination to search",
          sourceKey: "github:231",
        })
        return tx.transitionWorkItem(created.id, "ready", "unblocked")
      })
      expect(item.status).toBe("ready")
      const history = store.snapshot(run.id).transitions.filter(
        (entry) => entry.entityId === item.id,
      )
      expect(history.map((entry) => entry.toStatus)).toEqual(["pending", "ready"])
    })

    test("rejects illegal Work Item transitions", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      expect(() =>
        store.mutate(run.id, lease.fencingToken, (tx) => {
          const created = tx.upsertWorkItem({
            title: "Add pagination",
            objective: "Add pagination to search",
          })
          tx.transitionWorkItem(created.id, "completed", "skip verification")
        }),
      ).toThrow(TransitionError)
    })

    test("preserves Work Item identity for a stable source key", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      const first = store.mutate(run.id, lease.fencingToken, (tx) =>
        tx.upsertWorkItem({
          title: "Add pagination",
          objective: "first description",
          sourceKey: "github:231",
        }),
      )
      store.mutate(run.id, lease.fencingToken, (tx) => {
        tx.transitionWorkItem(first.id, "ready", "unblocked")
        tx.transitionWorkItem(first.id, "launching", "schedule")
      })
      const second = store.mutate(run.id, lease.fencingToken, (tx) =>
        tx.upsertWorkItem({
          title: "Add pagination",
          objective: "updated description",
          sourceKey: "github:231",
        }),
      )
      expect(second.id).toBe(first.id)
      expect(second.status).toBe("launching")
      expect(second.objective).toBe("updated description")
    })

    test("creates a successor instead of reopening completed work", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      const original = store.mutate(run.id, lease.fencingToken, (tx) => {
        const created = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
          sourceKey: "github:231",
        })
        tx.transitionWorkItem(created.id, "ready", "unblocked")
        tx.transitionWorkItem(created.id, "launching", "schedule")
        tx.transitionWorkItem(created.id, "running", "session attached")
        tx.transitionWorkItem(created.id, "verifying", "idle")
        tx.transitionWorkItem(created.id, "integrating", "checks passed")
        return tx.transitionWorkItem(created.id, "completed", "integrated")
      })
      const successor = store.mutate(run.id, lease.fencingToken, (tx) =>
        tx.upsertWorkItem({
          title: "Add pagination",
          objective: "changed acceptance",
          sourceKey: "github:231",
          contentFingerprint: "sha-2",
        }),
      )
      expect(successor.id).not.toBe(original.id)
      expect(successor.predecessorId).toBe(original.id)
      expect(store.getWorkItem(original.id)?.status).toBe("completed")
    })

    test("does not create a successor when a completed fingerprint is unchanged", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      const original = store.mutate(run.id, lease.fencingToken, (tx) => {
        const created = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
          sourceKey: "github:231",
          contentFingerprint: "sha-1",
        })
        tx.transitionWorkItem(created.id, "ready", "unblocked")
        tx.transitionWorkItem(created.id, "launching", "schedule")
        tx.transitionWorkItem(created.id, "running", "session attached")
        tx.transitionWorkItem(created.id, "verifying", "idle")
        tx.transitionWorkItem(created.id, "integrating", "checks passed")
        return tx.transitionWorkItem(created.id, "completed", "integrated")
      })
      const again = store.mutate(run.id, lease.fencingToken, (tx) =>
        tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
          sourceKey: "github:231",
          contentFingerprint: "sha-1",
        }),
      )
      expect(again.id).toBe(original.id)
      expect(again.status).toBe("completed")
      expect(store.snapshot(run.id).workItems.filter((item) => item.sourceKey === "github:231")).toHaveLength(1)
    })

    test("persists a Worker Attempt launch identity before a session exists", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      const attempt = store.mutate(run.id, lease.fencingToken, (tx) => {
        const item = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
        })
        tx.transitionWorkItem(item.id, "ready", "unblocked")
        tx.transitionWorkItem(item.id, "launching", "schedule")
        return tx.beginWorkerAttempt({
          workItemId: item.id,
          launchToken: "launch-1",
        })
      })
      expect(attempt.sessionId).toBeUndefined()
      expect(store.findAttemptByLaunchToken("launch-1")?.id).toBe(attempt.id)
    })

    test("rejects duplicate launch tokens", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      store.mutate(run.id, lease.fencingToken, (tx) => {
        const item = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
        })
        tx.transitionWorkItem(item.id, "ready", "unblocked")
        tx.transitionWorkItem(item.id, "launching", "schedule")
        tx.beginWorkerAttempt({
          workItemId: item.id,
          launchToken: "launch-1",
        })
      })
      expect(() =>
        store.mutate(run.id, lease.fencingToken, (tx) => {
          const item = tx.upsertWorkItem({
            title: "Fix export",
            objective: "Fix export",
          })
          tx.transitionWorkItem(item.id, "ready", "unblocked")
          tx.transitionWorkItem(item.id, "launching", "schedule")
          tx.beginWorkerAttempt({
            workItemId: item.id,
            launchToken: "launch-1",
          })
        }),
      ).toThrow("launch token already exists")
    })

    test("prevents colliding worktree reservations", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      store.mutate(run.id, lease.fencingToken, (tx) => {
        const item = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
        })
        tx.reserveWorktree(item.id, ".autopilot/worktrees/task-123", "autopilot/task-123")
      })
      expect(() =>
        store.mutate(run.id, lease.fencingToken, (tx) => {
          const item = tx.upsertWorkItem({
            title: "Fix export",
            objective: "Fix export",
          })
          tx.reserveWorktree(item.id, ".autopilot/worktrees/task-123", "autopilot/task-456")
        }),
      ).toThrow("worktree path already reserved")
    })

    test("marks a disappeared Worker as unknown without completing the Work Item", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      const item = store.mutate(run.id, lease.fencingToken, (tx) => {
        const created = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
        })
        tx.transitionWorkItem(created.id, "ready", "unblocked")
        tx.transitionWorkItem(created.id, "launching", "schedule")
        const attempt = tx.beginWorkerAttempt({
          workItemId: created.id,
          launchToken: "launch-1",
        })
        tx.attachSession(attempt.id, "ses_123")
        tx.transitionWorkItem(created.id, "running", "session attached")
        tx.recordUnknown(created.id, attempt.id, "session disappeared")
        return created.id
      })
      expect(store.getWorkItem(item)?.status).toBe("unknown")
      expect(store.getWorkItem(item)?.status).not.toBe("completed")
    })

    test("isolates a stuck Work Item after exhausting Worker Attempts", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      const item = store.mutate(run.id, lease.fencingToken, (tx) => {
        const created = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
        })
        tx.transitionWorkItem(created.id, "ready", "unblocked")
        tx.transitionWorkItem(created.id, "launching", "schedule")
        tx.transitionWorkItem(created.id, "running", "session attached")
        tx.transitionWorkItem(created.id, "verifying", "idle")
        tx.incrementFailedAttempts(created.id, 3)
        return tx.transitionWorkItem(created.id, "stuck", "retry limit")
      })
      const snapshot = store.snapshot(run.id)
      expect(item.status).toBe("stuck")
      expect(snapshot.workItems.find((entry) => entry.id === item.id)?.failedAttempts).toBe(3)
      expect(snapshot.run.status).toBe("enabled")
    })

    test("keeps an enabled Autopilot Run when the work queue is empty", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      expect(store.snapshot(run.id).workItems).toEqual([])
      expect(store.getRun(run.id)?.status).toBe("enabled")
    })

    test("reconciles observed sessions without duplicating launches", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      const { attached, missing } = store.mutate(run.id, lease.fencingToken, (tx) => {
        const first = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
        })
        tx.transitionWorkItem(first.id, "ready", "unblocked")
        tx.transitionWorkItem(first.id, "launching", "schedule")
        const attachedAttempt = tx.beginWorkerAttempt({
          workItemId: first.id,
          launchToken: "launch-attached",
        })
        const second = tx.upsertWorkItem({
          title: "Fix export",
          objective: "Fix export",
        })
        tx.transitionWorkItem(second.id, "ready", "unblocked")
        tx.transitionWorkItem(second.id, "launching", "schedule")
        const missingAttempt = tx.beginWorkerAttempt({
          workItemId: second.id,
          launchToken: "launch-missing",
        })
        return { attached: { itemId: first.id, attemptId: attachedAttempt.id }, missing: { itemId: second.id, attemptId: missingAttempt.id } }
      })
      store.reconcileObservedAttempts(run.id, lease.fencingToken, [
        { launchToken: "launch-attached", sessionId: "ses_alive" },
      ])
      expect(store.getWorkItem(attached.itemId)?.status).toBe("running")
      expect(store.findAttemptByLaunchToken("launch-attached")?.sessionId).toBe("ses_alive")
      expect(store.getWorkItem(missing.itemId)?.status).toBe("unknown")
      expect(store.findAttemptByLaunchToken("launch-missing")?.status).toBe("unknown")
    })

    test("reconcile missing session does not un-complete a completed Work Item", () => {
      const run = open().createRun({
        canonicalRoot: "/repo",
        objective: "goal",
      })
      const lease = store.acquireLease(run.id, "instance-a", TTL)
      store.mutate(run.id, lease.fencingToken, (tx) => {
        const created = tx.upsertWorkItem({
          title: "Add pagination",
          objective: "Add pagination",
        })
        tx.transitionWorkItem(created.id, "ready", "unblocked")
        tx.transitionWorkItem(created.id, "launching", "schedule")
        tx.beginWorkerAttempt({
          workItemId: created.id,
          launchToken: "launch-stale",
        })
        tx.transitionWorkItem(created.id, "running", "session attached")
        tx.transitionWorkItem(created.id, "verifying", "idle")
        tx.transitionWorkItem(created.id, "integrating", "checks passed")
        tx.transitionWorkItem(created.id, "completed", "integrated")
      })
      expect(() => store.reconcileObservedAttempts(run.id, lease.fencingToken, [])).not.toThrow()
      expect(store.getWorkItem(store.snapshot(run.id).workItems[0]?.id ?? "")?.status).toBe("completed")
      expect(store.findAttemptByLaunchToken("launch-stale")?.status).toBe("unknown")
    })

    if (name !== "sqlite memory AutopilotStore") {
      test("recovers persisted state after reopen", () => {
        const run = open().createRun({
          canonicalRoot: "/repo",
          objective: "Keep going until stopped.",
          autoResumeAfterRestart: false,
        })
        const lease = store.acquireLease(run.id, "instance-a", TTL)
        store.mutate(run.id, lease.fencingToken, (tx) => {
          tx.setRunStatus("recovery-hold", "restart")
          tx.upsertWorkItem({
            title: "Add pagination",
            objective: "Add pagination",
            dependencies: ["blocked-by-export"],
          })
        })
        store.close()
        store = store.reopen()
        const recovered = store.getRun(run.id)
        expect(recovered?.status).toBe("recovery-hold")
        expect(recovered?.objective).toBe("Keep going until stopped.")
        expect(store.snapshot(run.id).workItems[0]?.dependencies).toEqual(["blocked-by-export"])
      })
    }
  })
}

withStore("memory AutopilotStore", (clock) => AutopilotStore.memory({ clock: clock.now }))
withStore("sqlite memory AutopilotStore", (clock) =>
  AutopilotStore.sqlite(":memory:", { clock: clock.now }),
)

describe("sqlite AutopilotStore", () => {
  let directory: string

  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("persists across process-equivalent reopen and uses owner-only permissions", async () => {
    directory = await mkdtemp(join(tmpdir(), "autopilot-store-"))
    const path = join(directory, "state.sqlite")
    const clock = createClock()
    const first = AutopilotStore.sqlite(path, { clock: clock.now })
    const run = first.createRun({
      canonicalRoot: "/repo",
      objective: "Keep going until stopped.",
    })
    const lease = first.acquireLease(run.id, "instance-a", TTL)
    first.mutate(run.id, lease.fencingToken, (tx) => {
      tx.setRunStatus("recovery-hold", "restart")
    })
    first.close()

    const { mode } = await Bun.file(path).stat()
    expect(mode & 0o777).toBe(0o600)

    const second = AutopilotStore.sqlite(path, { clock: clock.now })
    expect(second.getRun(run.id)?.status).toBe("recovery-hold")
    expect(second.getRun(run.id)?.objective).toBe("Keep going until stopped.")
    second.close()
  })

  test("reads do not persist and getRun does not wipe rows", async () => {
    directory = await mkdtemp(join(tmpdir(), "autopilot-store-"))
    const path = join(directory, "state.sqlite")
    const driver = new SqliteDriver(path)
    driver.transact((state) => {
      state.runs.set("run-1", {
        id: "run-1",
        canonicalRoot: "/repo",
        objective: "Keep going until stopped.",
        status: "enabled",
        autoResumeAfterRestart: false,
        concurrency: 4,
        maxRetriesPerWorkItem: 3,
        pollIntervalMs: 30_000,
        createdAt: 1,
        updatedAt: 1,
      })
    })
    const afterWrite = driver.persistCount
    const read = driver.read((state) => state.runs.get("run-1")?.objective)
    expect(read).toBe("Keep going until stopped.")
    expect(driver.persistCount).toBe(afterWrite)
    driver.close()

    const store = AutopilotStore.sqlite(path)
    const run = store.createRun({
      canonicalRoot: "/other",
      objective: "Second run.",
    })
    expect(store.getRun(run.id)?.objective).toBe("Second run.")
    store.close()
    const reopened = AutopilotStore.sqlite(path)
    expect(reopened.getRun(run.id)?.objective).toBe("Second run.")
    reopened.close()
  })
})
