# Implement plugin control and Supervisor loop

Type: task
Status: resolved
Blocked by: 08, 09, 10, 11

## Question

Implement legacy OpenCode plugin registration, `/autopilot` command templates, deterministic control tool, plugin-resident Supervisor loop, pause/resume/stop semantics, Recovery Hold, polling backoff, concise status, and startup compatibility probes.

## Answer

Legacy plugin registers `/autopilot` via `config.command` and a deterministic `autopilot` tool. Supervisor implements start, status, pause, resume, stop, force stop, tick, idle handling, and concise status. Restart recovery uses stored Recovery Hold plus `/autopilot resume`.

Tests: `test/supervisor.test.ts`. Plugin: `src/index.ts`.
