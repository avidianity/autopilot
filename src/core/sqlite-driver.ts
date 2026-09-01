import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Database } from "bun:sqlite"

import { cloneState, emptyState, type State } from "./state.js"
import type {
  RunRecord,
  RunStatus,
  SupervisorLeaseRecord,
  TransitionRecord,
  WorkerAttemptRecord,
  WorkItemRecord,
  WorkItemStatus,
  WorktreeReservation,
} from "./types.js"

export class SqliteDriver {
  persistCount = 0
  private db: Database

  constructor(private readonly path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    }
    this.db = this.open()
  }

  read<T>(fn: (state: State) => T): T {
    this.db.exec("BEGIN DEFERRED")
    try {
      const result = fn(loadState(this.db))
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  transact<T>(fn: (state: State) => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const state = cloneState(loadState(this.db))
      const result = fn(state)
      persistState(this.db, state)
      this.persistCount += 1
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  reopen(): SqliteDriver {
    this.close()
    return new SqliteDriver(this.path)
  }

  private open(): Database {
    const db = new Database(this.path, { create: true })
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 5000")
    initializeSchema(db)
    if (this.path !== ":memory:") {
      chmodSync(this.path, 0o600)
      for (const sidecar of [`${this.path}-wal`, `${this.path}-shm`]) {
        try {
          chmodSync(sidecar, 0o600)
        } catch {
          // sidecar may not exist yet
        }
      }
    }
    return db
  }
}

function initializeSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      canonical_root TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      auto_resume_after_restart INTEGER NOT NULL,
      concurrency INTEGER NOT NULL,
      max_retries_per_work_item INTEGER NOT NULL,
      poll_interval_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      dependencies TEXT NOT NULL,
      failed_attempts INTEGER NOT NULL,
      source_key TEXT,
      content_fingerprint TEXT,
      predecessor_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      launch_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worktrees (
      work_item_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS leases (
      run_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transitions (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_root
      ON runs(canonical_root) WHERE status != 'stopped';
  `)
}

function loadState(db: Database): State {
  const state = emptyState()
  for (const row of db.query("SELECT * FROM runs").all() as Record<string, unknown>[]) {
    const record: RunRecord = {
      id: String(row.id),
      canonicalRoot: String(row.canonical_root),
      objective: String(row.objective),
      status: row.status as RunStatus,
      autoResumeAfterRestart: Boolean(row.auto_resume_after_restart),
      concurrency: Number(row.concurrency),
      maxRetriesPerWorkItem: Number(row.max_retries_per_work_item),
      pollIntervalMs: Number(row.poll_interval_ms),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
    state.runs.set(record.id, record)
  }
  for (const row of db.query("SELECT * FROM work_items").all() as Record<string, unknown>[]) {
    const record: WorkItemRecord = {
      id: String(row.id),
      runId: String(row.run_id),
      title: String(row.title),
      objective: String(row.objective),
      status: row.status as WorkItemStatus,
      dependencies: JSON.parse(String(row.dependencies)) as string[],
      failedAttempts: Number(row.failed_attempts),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
    if (typeof row.source_key === "string") {
      record.sourceKey = row.source_key
    }
    if (typeof row.content_fingerprint === "string") {
      record.contentFingerprint = row.content_fingerprint
    }
    if (typeof row.predecessor_id === "string") {
      record.predecessorId = row.predecessor_id
    }
    state.workItems.set(record.id, record)
  }
  for (const row of db.query("SELECT * FROM worker_attempts").all() as Record<string, unknown>[]) {
    const record: WorkerAttemptRecord = {
      id: String(row.id),
      runId: String(row.run_id),
      workItemId: String(row.work_item_id),
      launchToken: String(row.launch_token),
      status: row.status as WorkerAttemptRecord["status"],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
    if (typeof row.session_id === "string") {
      record.sessionId = row.session_id
    }
    state.attempts.set(record.id, record)
  }
  for (const row of db.query("SELECT * FROM worktrees").all() as Record<string, unknown>[]) {
    const record: WorktreeReservation = {
      workItemId: String(row.work_item_id),
      runId: String(row.run_id),
      path: String(row.path),
      branch: String(row.branch),
    }
    state.worktrees.set(record.workItemId, record)
  }
  for (const row of db.query("SELECT * FROM leases").all() as Record<string, unknown>[]) {
    const record: SupervisorLeaseRecord = {
      runId: String(row.run_id),
      instanceId: String(row.instance_id),
      fencingToken: Number(row.fencing_token),
      expiresAt: Number(row.expires_at),
    }
    state.leases.set(record.runId, record)
  }
  for (const row of db.query("SELECT * FROM transitions ORDER BY id").all() as Record<string, unknown>[]) {
    const record: TransitionRecord = {
      id: Number(row.id),
      runId: String(row.run_id),
      entityType: row.entity_type as TransitionRecord["entityType"],
      entityId: String(row.entity_id),
      toStatus: String(row.to_status),
      reason: String(row.reason),
      fencingToken: Number(row.fencing_token),
      createdAt: Number(row.created_at),
    }
    if (typeof row.from_status === "string") {
      record.fromStatus = row.from_status
    }
    state.transitions.push(record)
    state.nextTransitionId = Math.max(state.nextTransitionId, record.id + 1)
  }
  return state
}

function persistState(db: Database, state: State): void {
  db.exec("DELETE FROM transitions")
  db.exec("DELETE FROM leases")
  db.exec("DELETE FROM worktrees")
  db.exec("DELETE FROM worker_attempts")
  db.exec("DELETE FROM work_items")
  db.exec("DELETE FROM runs")

  const insertRun = db.prepare(`
    INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const run of state.runs.values()) {
    insertRun.run(
      run.id,
      run.canonicalRoot,
      run.objective,
      run.status,
      run.autoResumeAfterRestart ? 1 : 0,
      run.concurrency,
      run.maxRetriesPerWorkItem,
      run.pollIntervalMs,
      run.createdAt,
      run.updatedAt,
    )
  }

  const insertItem = db.prepare(`
    INSERT INTO work_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const item of state.workItems.values()) {
    insertItem.run(
      item.id,
      item.runId,
      item.title,
      item.objective,
      item.status,
      JSON.stringify(item.dependencies),
      item.failedAttempts,
      item.sourceKey ?? null,
      item.contentFingerprint ?? null,
      item.predecessorId ?? null,
      item.createdAt,
      item.updatedAt,
    )
  }

  const insertAttempt = db.prepare(`
    INSERT INTO worker_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const attempt of state.attempts.values()) {
    insertAttempt.run(
      attempt.id,
      attempt.runId,
      attempt.workItemId,
      attempt.launchToken,
      attempt.status,
      attempt.sessionId ?? null,
      attempt.createdAt,
      attempt.updatedAt,
    )
  }

  const insertTree = db.prepare(`
    INSERT INTO worktrees VALUES (?, ?, ?, ?)
  `)
  for (const tree of state.worktrees.values()) {
    insertTree.run(tree.workItemId, tree.runId, tree.path, tree.branch)
  }

  const insertLease = db.prepare(`
    INSERT INTO leases VALUES (?, ?, ?, ?)
  `)
  for (const lease of state.leases.values()) {
    insertLease.run(lease.runId, lease.instanceId, lease.fencingToken, lease.expiresAt)
  }

  const insertTransition = db.prepare(`
    INSERT INTO transitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const entry of state.transitions) {
    insertTransition.run(
      entry.id,
      entry.runId,
      entry.entityType,
      entry.entityId,
      entry.fromStatus ?? null,
      entry.toStatus,
      entry.reason,
      entry.fencingToken,
      entry.createdAt,
    )
  }
}
