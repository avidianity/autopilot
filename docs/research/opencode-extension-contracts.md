# Installed OpenCode Extension Contracts

Research date: 2026-09-01

## Decision

Build Autopilot against the installed legacy `@opencode-ai/plugin` contract, not the V2 catalog API.
Reuse the existing `dynamic-task.ts` session-based subagent implementation instead of creating another agent runner.
Register any user-facing slash commands through resolved `config.command` entries, while registering model-callable operations through the legacy `tool` hook.
Treat plugin state as process-local and disposable.
Persist orchestration state outside the plugin process, recover it from OpenCode sessions where possible, and require an OpenCode process restart after plugin code or registration changes.
Require a Git repository before enabling worktree-isolated execution.

## Installed Runtime

The locally executed binary is `/home/avidian/.opencode/bin/opencode` and reports version `1.18.25`.
This was verified with `opencode --version` and `which opencode`.

Two different plugin package installations exist:

- Global config dependency: `@opencode-ai/plugin@1.18.21`, declared in `/home/avidian/.config/opencode/package.json:3` and identified by `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/package.json:4`.
- CLI-managed dependency: `@opencode-ai/plugin@1.16.2`, declared in `/home/avidian/.opencode/package.json:3` and identified by `/home/avidian/.opencode/node_modules/@opencode-ai/plugin/package.json:4`.

Plugin code loaded from global config resolves imports against the global config installation.
Do not infer runtime support from the CLI-managed package version alone.
Pin and test the plugin package version used by the plugin itself because it currently trails the CLI by four patch releases.

`opencode debug info` reports both discovered external plugins:

- `file:///home/avidian/.config/opencode/plugins/dynamic-task.ts`
- `file:///home/avidian/.config/opencode/plugins/headroom.ts`

`opencode debug config` confirms both are in the resolved global plugin list even though only `headroom.ts` is explicitly listed in `/home/avidian/.config/opencode/opencode.jsonc:9`.
Therefore files under the global `plugins/` directory are auto-discovered and merged with explicit plugin configuration.

## Legacy Plugin Contract

The legacy root export is the active extension surface used by `dynamic-task.ts`.
A plugin is an async function receiving `client`, `project`, `directory`, `worktree`, `serverUrl`, Bun shell `$`, and experimental workspace registration, and returning a `Hooks` object.
The hook object supports `dispose`, generic `event`, `config`, `tool`, authentication/provider hooks, command/tool lifecycle interception, permission interception, shell environment mutation, and chat transforms.
Source: `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts:36-56,173-322`.

Model-callable tools are registered by returning `tool: { [name]: tool(...) }`.
Tool execution receives session, message, agent, directory, worktree, abort, metadata, and permission-request context.
Tool results may be text or structured title/output/metadata/attachments.
Source: `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts:2-59`.

The plugin input's `directory` is current project directory and `worktree` is project worktree root.
Tool code should use the corresponding context fields rather than `process.cwd()`.
Source: `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts:36-46` and `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts:2-16`.

## Legacy Versus V2

The global config package exports V2 Promise and Effect APIs as explicit subpaths, while its root export remains legacy.
Source: `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/package.json:11-39`.

V2 is a catalog customization API:

- A V2 plugin has an `id` and `setup(context)` and is managed by add/remove registration.
- Context exposes reloadable agent, catalog, command, reference, and skill domains plus AI SDK and integration domains.
- Command drafts can list, get, update, and remove commands, but cannot add commands.
- Agent drafts can list, get, select default, update, and remove agents, but cannot add agents.
- Skill drafts can add skill sources and list sources.
- Registrations are disposable and selected domains expose explicit `reload()`.

Sources: `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/v2/promise/plugin.d.ts:2-10`, `context.d.ts:11-21`, `registration.d.ts:1-9`, `../effect/command.d.ts:3-8`, `../effect/agent.d.ts:3-9`, and `../effect/skill.d.ts:3-6`.

V2 does not expose the legacy runtime tool, session client, generic event, permission, or lifecycle hook contracts needed by Autopilot.
Its command transform cannot create a command.
Use V2 only if a later requirement needs catalog filtering or mutation, and keep that integration separate from the legacy orchestration plugin.

`opencode debug v2` exists in CLI `1.18.25`, but currently reports an empty provider catalog and internal Effect values for defaults.
This confirms V2 code is present, not that V2 is a stable substitute for legacy plugins.

## Commands And Tools

Slash commands are configuration records under `config.command[name]` with `template`, optional `description`, `agent`, `model`, `variant`, and `subtask` fields.
Source: `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1550-1564`.

The legacy plugin `config(input)` hook may mutate this resolved configuration before use.
Source: `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts:173-181`.

The legacy `command.execute.before` hook intercepts execution but is not itself command registration.
Source: `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts:228-234`.

Capability discovery must query runtime APIs instead of assuming configured capabilities:

- Commands: `client.command.list()` / `GET /command`.
- Tools: `client.tool.ids()` for built-in and dynamically registered IDs; `client.tool.list()` for provider/model-specific schemas.
- Agents: `client.app.agents()` / `GET /agent`.
- Skills: `client.app.skills()` / `GET /skill`.
- MCP: `client.mcp.status()` / `GET /mcp`.
- Resolved configuration: `client.config.get()`.

Sources: `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:47-80,347-397,582-591,658-694` and `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:5394-5467,5514-5538`.

MCP can be configured as a local command/environment process or remote URL/headers/OAuth service.
The API also supports dynamic add, connect, and disconnect.
Sources: `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1496-1536` and `sdk.gen.d.ts:658-694`.

## Sessions And Events

OpenCode sessions are the correct execution primitive for subagents.
The API supports parent-linked creation, listing/status/get/update/children, message retrieval, synchronous prompting, asynchronous prompting in the legacy client, fork, and abort.
Sources: `/home/avidian/.config/opencode/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:106-198` and `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:971-1165`.

The generic event stream is available through `client.event.subscribe()` and the legacy plugin receives the same event union through its `event` hook.
Source: `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:336-345` and `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts:173-177`.

Relevant typed events include:

- `session.status`
- `session.idle`
- `session.error`
- `command.executed`
- `mcp.tools.changed`
- `permission.asked` and `permission.replied`
- `permission.v2.asked` and `permission.v2.replied`
- `worktree.ready` and `worktree.failed`

Source: `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:989-1053,1127-1202,1263-1299`.

Prefer `session.status` for general state tracking.
Use terminal `session.idle` and `session.error` events to complete background jobs, as the existing implementation does.
Do not poll sessions when event delivery is available.

## Existing Parallel-Subagent Infrastructure

`/home/avidian/.config/opencode/plugins/dynamic-task.ts` already implements the required parallel runner:

- Registers the model-callable `task` tool through the legacy API at lines 246-414.
- Discovers agents dynamically with `client.app.agents()` and rejects primary-only agents at lines 159-167.
- Enforces configured subagent depth by traversing parent sessions at lines 169-182 and 274-280.
- Creates parent-linked child sessions at lines 126-133 and 311-323.
- Resolves model and variant inheritance at lines 135-157 and 294-308.
- Supports synchronous and asynchronous prompts at lines 337-410.
- Uses `session.idle` and `session.error` to deliver background results to the parent at lines 203-245.
- Propagates cancellation to synchronous child sessions at lines 366-410.
- Requests the `task` permission before launch at lines 282-292.
- Prevents recursive child access to `task` and `todowrite` for new sessions at lines 64-67 and 338-344.

Autopilot should call or extract this infrastructure rather than duplicate session creation, model selection, depth enforcement, cancellation, and result forwarding.
The smallest safe integration is to preserve one owner for child-session execution and add orchestration around it.

Important limitations to address in design, not by duplicating the runner:

- Background jobs live only in an in-memory `Map` at lines 119-120 and 346-348.
- A process restart loses notification routing for running children.
- Pending entries are deleted before parent notification at lines 225-234, so a notification failure is logged but not retried.
- Result extraction checks only the latest 20 messages at lines 184-201.
- Resuming `task_id` accepts any accessible session and does not verify its parent or agent at lines 311-320.

## Lifecycle And Restart Behavior

Legacy plugins expose only process lifecycle disposal through `Hooks.dispose`.
They expose no reload registration contract.
Source: `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts:173-181`.

The server API exposes instance disposal to release instance resources.
Source: `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:506-515`.

V2's explicit `reload()` applies to selected catalogs and is not a legacy plugin-module hot reload mechanism.
Source: `/home/avidian/.config/opencode/node_modules/@opencode-ai/plugin/dist/v2/promise/context.d.ts:11-21` and `registration.d.ts:4-6`.

No installed public contract guarantees hot reload of a changed legacy plugin module or recovery of its in-memory state.
Therefore operational behavior must be conservative:

- Restart the owning TUI/server process after plugin code, command registration, or configuration changes.
- Expect `dispose` during orderly instance shutdown, but do not rely on it for durable correctness.
- Store durable job records outside module memory before launching work.
- On startup, reconcile durable jobs against session status/messages and event delivery.
- Make completion delivery idempotent because restart can occur between child completion and parent notification.

## Git And Worktree Prerequisites

`/home/avidian/Development/autopilot` is not currently a Git repository.
`git rev-parse --show-toplevel` fails with `fatal: not a git repository`.

OpenCode's worktree API explicitly creates, lists, resets, and removes Git worktrees, with create running configured startup scripts.
Source: `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:399-438`.

OpenCode's project-copy API supports `strategy: "git_worktree"`.
Source: `/home/avidian/.opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:163-197`.

Consequences:

- Session-based parallelism can operate without creating worktrees.
- Worktree-isolated execution cannot be enabled in this directory until it is initialized as a Git repository with a usable commit and branch.
- Before creating a worktree, verify repository discovery, a valid `HEAD`, branch naming, clean/conflict policy, destination uniqueness, and availability of startup prerequisites.
- Never assume the plugin input's `worktree` field proves Git worktree capability; capability must be checked through Git and/or the OpenCode worktree API.

## Implementation Constraints For Follow-Up Tickets

1. Target legacy `Plugin` and `Hooks` from `@opencode-ai/plugin` for orchestration.
2. Reuse one child-session runner based on `dynamic-task.ts`.
3. Register slash commands through `config.command`; use tools for model invocation.
4. Discover tools, agents, skills, commands, MCP status, and resolved config at runtime.
5. Persist jobs before launch and reconcile after restart.
6. Make event handling and parent notification idempotent.
7. Gate worktree mode on explicit Git checks; retain session-only parallelism as separate capability.
8. Pin compatible CLI/plugin versions and run a startup compatibility probe because local versions are currently skewed.
