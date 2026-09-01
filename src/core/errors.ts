export class StaleLeaseError extends Error {
  override readonly name = "StaleLeaseError"

  constructor() {
    super("stale Supervisor Lease fencing token")
  }
}

export class TransitionError extends Error {
  override readonly name = "TransitionError"

  constructor(from: string, to: string) {
    super(`illegal transition from ${from} to ${to}`)
  }
}

export class DuplicateRunError extends Error {
  override readonly name = "DuplicateRunError"

  constructor() {
    super("active Autopilot Run already exists")
  }
}

export class DuplicateLaunchTokenError extends Error {
  override readonly name = "DuplicateLaunchTokenError"

  constructor() {
    super("launch token already exists")
  }
}

export class WorktreeCollisionError extends Error {
  override readonly name = "WorktreeCollisionError"

  constructor() {
    super("worktree path already reserved")
  }
}
