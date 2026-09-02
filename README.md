# OpenCode Autopilot

Persistent Supervisor plugin for OpenCode.

Workers may stop. The Supervisor does not, until `/autopilot stop`.

## Install

This repository is the plugin package `@avidian/opencode-autopilot`.

1. Pin `@opencode-ai/plugin` to the version your OpenCode config resolves (currently `1.18.21`).
2. Add the plugin to project or global OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./src/index.ts"]
}
```

After `npm publish`:

```bash
opencode plugin @avidian/opencode-autopilot
```

Or in config:

```json
{
  "plugin": ["@avidian/opencode-autopilot"]
}
```

The package exports `./server` (and `main`) so `opencode plugin` can find the server plugin entry.

3. Quit and restart OpenCode. Config and plugins load once at startup.

## Commands

```text
/autopilot <goal>
/autopilot status
/autopilot pause
/autopilot resume
/autopilot stop
/autopilot stop --force
```

The original goal is the Autopilot Objective for that Autopilot Run.

## How it works

1. Deterministic Supervisor owns state, scheduling, leases, retries, stop/pause.
2. Semantic Engine interprets the objective, proposes a plan, and may compile Worker Instructions.
3. Work Source adapters emit immutable Discovery Evidence. Only selected sources run.
4. Planner validates and applies Work Items transactionally.
5. SessionRunner launches isolated Workers. Launch identity is persisted first.
6. Verification Plans and process/git checks decide completion. Worker claims are not enough.
7. Verified commits integrate on a dedicated Run Branch through one Integration Lane.

State lives at `<repo>/.opencode/autopilot/state.sqlite` (gitignored).

Restart default is Recovery Hold. Call `/autopilot resume`. Set `autoResumeAfterRestart` when constructing Supervisor for unattended resume.

## Worker Instruction selection

The compiler uses a Capability snapshot (commands, skills, agents, tools, MCP, repository facilities).

A specialized slash command is used only with explicit fit evidence and a known Capability id. Otherwise the Worker gets a raw prompt for that Work Item only.

## Work Sources

Shipped adapters:

- direct objective
- GitHub issues (`gh`)
- failing tests/lint/typecheck/build
- markdown task lists
- explicit files
- repository TODOs

## Tests

```text
bun test
bun run typecheck
bun run lint
bun run build
```

## Limitations

- OpenCode session client wiring is adapter-shaped; live session create/prompt paths need a running OpenCode process.
- First Semantic Engine in the plugin is scripted/default, not a live model, until an OpenCode completion port is supplied.
- Git worktree creation is reserved in state; filesystem git worktree execution still depends on Git availability.
- Compatibility: CLI `1.18.25` vs plugin SDK `1.18.21`. Restart OpenCode after plugin changes.
