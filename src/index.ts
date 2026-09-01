import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import { AutopilotStore } from "./core/store.js"
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
    "interpret-objective": {
      operation: "interpret-objective",
      sources: [
        {
          id: "direct-objective",
          rank: 1,
          reason: "default direct objective",
          hints: {},
        },
      ],
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
  const process = new BunProcessPort()
  const verify = new ConstrainedProcessPort(process, VERIFY_ALLOW)
  const git = new RealGitPort(root)
  const created = new Supervisor({
    store: AutopilotStore.sqlite(`${root}/.opencode/autopilot/state.sqlite`),
    engine: new FallbackSemanticEngine(completionPortFrom(client), scriptedFallbackEngine()),
    runner: new OpenCodeSessionRunner(client),
    worktrees: new GitWorktreePort(root),
    process: verify,
    git,
    canonicalRoot: root,
    gitAvailable: git.available(),
    sources: [
      new GitHubIssueSource(process),
      new RepositoryCheckSource(process),
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
        template: "Use the autopilot tool with input: $ARGUMENTS",
      }
      ;(cfg as { command?: Record<string, { template: string; description?: string }> }).command = commands
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle") {
        return
      }
      const sessionId = (event.properties as { sessionID?: string }).sessionID
      if (!sessionId) {
        return
      }
      supervisors.get(directory)?.handleIdle(sessionId)
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
            return supervisor.status()
          }
          if (parsed.action === "pause") {
            return supervisor.pause()
          }
          if (parsed.action === "resume") {
            supervisor.ensureLoop()
            return supervisor.resume()
          }
          if (parsed.action === "stop") {
            return supervisor.stop(parsed.force === true)
          }
          const started = supervisor.start(parsed.objective ?? args.input)
          supervisor.ensureLoop()
          return started
        },
      }),
    },
  }
}) satisfies Plugin

export default AutopilotPlugin
export { AutopilotStore } from "./core/store.js"
export { Supervisor, parseAutopilotInput } from "./supervisor.js"
