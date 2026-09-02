import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import { AutopilotStore } from "./core/store.js"
import { selectWorkSourcesFromObjective } from "./planning/interpret.js"
import { ScriptedSemanticEngine } from "./planning/scripted-engine.js"
import type { SemanticEngine, SemanticRequest, SemanticResult } from "./planning/types.js"
import { parseAutopilotInput, Supervisor } from "./supervisor.js"
import { GitHubIssueSource } from "./sources/github.js"
import { RepositoryCheckSource } from "./sources/checks.js"
import {
  ExplicitFileSource,
  MarkdownTaskSource,
  RootFilePort,
  TodoSource,
} from "./sources/markdown.js"
import { RealGitPort } from "./verify/git.js"
import { BunProcessPort, ConstrainedProcessPort } from "./verify/process.js"
import { GitWorktreePort } from "./workers/lifecycle.js"
import { OpenCodeSessionRunner, type OpenCodeSessionClient } from "./workers/session-runner.js"

const VERIFY_ALLOW = new Set(["bun", "git"])
const supervisors = new Map<string, Supervisor>()

function scriptedFallbackEngine(): ScriptedSemanticEngine {
  return new ScriptedSemanticEngine({
    "interpret-objective": (request) => {
      if (request.operation !== "interpret-objective") {
        throw new Error("unexpected operation")
      }
      return {
        operation: "interpret-objective",
        sources: selectWorkSourcesFromObjective(request.objective),
      }
    },
    "propose-plan": (request) => {
      if (request.operation !== "propose-plan") {
        throw new Error("unexpected operation")
      }
      return {
        operation: "propose-plan",
        items: request.evidence.map((entry) => ({
          sourceKey: entry.sourceKey,
          title: entry.title,
          objective: entry.body || entry.title,
          dependencies: [],
        })),
      }
    },
  })
}

class FallbackSemanticEngine implements SemanticEngine {
  constructor(
    private readonly primary: SemanticEngine | undefined,
    private readonly fallback: SemanticEngine,
  ) {}

  async run(request: SemanticRequest): Promise<SemanticResult> {
    if (this.primary) {
      try {
        return await this.primary.run(request)
      } catch {
        return this.fallback.run(request)
      }
    }
    return this.fallback.run(request)
  }
}

function completionPortFrom(client: OpenCodeSessionClient): SemanticEngine | undefined {
  void client
  return undefined
}

export function supervisorFor(root: string, client: OpenCodeSessionClient): Supervisor {
  const existing = supervisors.get(root)
  if (existing) {
    return existing
  }
  const files = new RootFilePort(root)
  const discovery = new BunProcessPort()
  const verify = new ConstrainedProcessPort(new BunProcessPort(), VERIFY_ALLOW)
  const git = new RealGitPort(root)
  const storePath = `${root}/.opencode/autopilot/state.sqlite`
  const created = new Supervisor({
    store: AutopilotStore.sqlite(storePath),
    engine: new FallbackSemanticEngine(completionPortFrom(client), scriptedFallbackEngine()),
    runner: new OpenCodeSessionRunner(client),
    worktrees: new GitWorktreePort(root),
    process: verify,
    git,
    canonicalRoot: root,
    gitAvailable: git.available(),
    catalogPath: `${root}/.opencode/autopilot/verification.json`,
    spawnMode: "orchestrator",
    sources: [
      new GitHubIssueSource(discovery, root),
      new RepositoryCheckSource(discovery, root),
      new MarkdownTaskSource(files),
      new TodoSource(files),
      new ExplicitFileSource(files),
    ],
  })
  supervisors.set(root, created)
  return created
}

export const AutopilotPlugin = (async ({ client, directory }) => {
  return {
    config: async (cfg) => {
      const commands = (cfg as { command?: Record<string, { template: string; description?: string }> }).command ?? {}
      commands.autopilot = {
        description: "Run persistent Autopilot against an objective, or status/pause/resume/stop.",
        template: `You are the Autopilot orchestrator in this chat. Stay in this session. Do not go idle until the user says stop.

1. Call the autopilot tool with input: $ARGUMENTS
2. Read the tool output. For every item under "Spawn with the task tool", call the task tool (your installed dynamic-task plugin) with:
   - description: the Work Item title
   - prompt: the provided Worker prompt (includes the global objective)
   - subagent_type: general
   - background: true
   - model/effort: only if the user named them in the objective
3. Those task calls must be children of this chat so they appear in the UI Subagents list.
4. When a task notifies you it finished, call autopilot with input: status and spawn the next ready items.
5. Repeat until status shows no ready/running/repairing work, or the user says stop.
6. To inspect progress, call autopilot with input: status. Never use input: start if a run is already enabled.

User arguments:
$ARGUMENTS`,
      }
      ;(cfg as { command?: Record<string, { template: string; description?: string }> }).command = commands
    },
    event: async ({ event }) => {
      const sessionId = (event.properties as { sessionID?: string }).sessionID
      if (!sessionId) {
        return
      }
      let supervisor = supervisors.get(directory)
      if (!supervisor && (event.type === "session.error" || event.type === "session.idle")) {
        try {
          supervisor = supervisorFor(directory, client as unknown as OpenCodeSessionClient)
        } catch {
          return
        }
      }
      if (!supervisor) {
        return
      }
      if (event.type === "session.idle") {
        supervisor.handleIdle(sessionId)
        return
      }
      if (event.type === "session.error") {
        supervisor.handleSessionHook(sessionId, "error")
      }
    },
    async dispose() {
      const supervisor = supervisors.get(directory)
      supervisor?.dispose()
      supervisors.delete(directory)
    },
    tool: {
      autopilot: tool({
        description: "Control the Autopilot Supervisor for this project.",
        args: {
          input: tool.schema.string().describe("objective, status, pause, resume, stop, or stop --force"),
        },
        async execute(args) {
          const parsed = parseAutopilotInput(args.input)
          const supervisor = supervisorFor(directory, client as unknown as OpenCodeSessionClient)
          if (parsed.action === "status") {
            await supervisor.tick()
            return supervisor.spawnBoard()
          }
          if (parsed.action === "pause") {
            return supervisor.pause()
          }
          if (parsed.action === "resume") {
            supervisor.resume()
            await supervisor.tick()
            return supervisor.spawnBoard()
          }
          if (parsed.action === "stop") {
            return supervisor.stop(parsed.force === true)
          }
          supervisor.start(parsed.objective ?? args.input)
          await supervisor.tick()
          return supervisor.spawnBoard()
        },
      }),
    },
  }
}) satisfies Plugin

export default AutopilotPlugin
export { AutopilotStore } from "./core/store.js"
export { Supervisor, parseAutopilotInput } from "./supervisor.js"
