# Research installed OpenCode extension contracts

Type: research
Status: resolved

## Question

What exact contracts does the locally installed OpenCode version expose for plugins, commands, sessions, events, agents, skills, MCP tools, permissions, and process lifecycle, and which existing parallel-subagent infrastructure should Autopilot reuse rather than duplicate?

## Answer

Target the installed legacy `@opencode-ai/plugin` API because it provides runtime hooks, tools, events, sessions, and config mutation; V2 is currently a catalog transformation API and cannot add commands.
Register `/autopilot` through `config.command` and expose model-callable operations through legacy tools.
Reuse or extract the existing `dynamic-task.ts` child-session runner rather than duplicating session creation, model selection, cancellation, depth limits, and result forwarding.
Persist all orchestration records before launch and reconcile sessions after restart because existing background job state is process-local and event delivery must be idempotent.
Discover commands, tools, agents, skills, MCP status, and resolved config through runtime APIs.
Require explicit Git capability checks before worktree execution; session-only parallelism remains available without Git.
Pin and probe compatibility because local CLI `1.18.25` and active plugin SDK `1.18.21` differ.

Detailed evidence and API references: [Installed OpenCode Extension Contracts](../../../docs/research/opencode-extension-contracts.md).
