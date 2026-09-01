# Persist state in SQLite with fenced ownership

Autopilot stores current state and transition history in a project-local SQLite database because atomic transitions, uniqueness constraints, and crash recovery are control-loop requirements rather than optional storage features.
A renewable Supervisor Lease with a monotonically increasing fencing token prevents stale OpenCode processes from scheduling or mutating state after ownership changes.
