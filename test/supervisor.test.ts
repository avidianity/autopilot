import { describe, expect, test } from "bun:test"

import { AutopilotStore } from "../src/core/store.js"
import { ScriptedSemanticEngine } from "../src/planning/scripted-engine.js"
import { parseAutopilotInput, Supervisor } from "../src/supervisor.js"
import { FakeGitPort } from "../src/verify/git.js"
import { FakeProcessPort } from "../src/verify/process.js"
import { InMemoryWorktreePort } from "../src/workers/lifecycle.js"
import { FakeSessionRunner } from "../src/workers/session-runner.js"
import { GitHubIssueSource } from "../src/sources/github.js"
import { ExplicitFileSource, MarkdownTaskSource, MemoryFilePort, TodoSource } from "../src/sources/markdown.js"
import { RepositoryCheckSource } from "../src/sources/checks.js"

function engineForEvidence() {
  return new ScriptedSemanticEngine({
    "interpret-objective": {
      operation: "interpret-objective",
      sources: [{ id: "direct-objective", rank: 1, reason: "direct", hints: {} }],
    },
    "propose-plan": (request) => ({
      operation: "propose-plan",
      items:
        request.operation === "propose-plan"
          ? request.evidence.map((entry) => ({
              sourceKey: entry.sourceKey,
              title: entry.title,
              objective: entry.body || entry.title,
              dependencies: [],
            }))
          : [],
    }),
  })
}

function createSupervisor() {
  const store = AutopilotStore.memory()
  const runner = new FakeSessionRunner()
  const supervisor = new Supervisor({
    store,
    engine: engineForEvidence(),
    runner,
    worktrees: new InMemoryWorktreePort(),
    process: new FakeProcessPort(),
    git: new FakeGitPort(),
    canonicalRoot: "/repo",
    gitAvailable: false,
  })
  return { store, runner, supervisor }
}

describe("Supervisor control", () => {
  test("persists the Autopilot Objective and stays idle until stopped", async () => {
    const { supervisor } = createSupervisor()
    supervisor.start("Keep the repository healthy.")
    expect(supervisor.status()).toContain("Keep the repository healthy.")
    supervisor.stop()
    expect(supervisor.status()).toContain("stopped")
    await supervisor.tick()
    expect(supervisor.status()).toContain("stopped")
  })

  test("rejects a second Autopilot Run for the same root", () => {
    const { supervisor } = createSupervisor()
    supervisor.start("first")
    expect(supervisor.start("second")).toContain("already running")
    expect(supervisor.status()).toContain("first")
  })

  test("pause stops scheduling and resume continues", async () => {
    const { supervisor, runner } = createSupervisor()
    supervisor.start("Fix the failing authentication tests.")
    supervisor.pause()
    await supervisor.tick()
    expect(runner.createCalls).toBe(0)
    supervisor.resume()
    await supervisor.tick()
    expect(runner.createCalls).toBeGreaterThan(0)
  })

  test("parses control input", () => {
    expect(parseAutopilotInput("status").action).toBe("status")
    expect(parseAutopilotInput("pause").action).toBe("pause")
    expect(parseAutopilotInput("resume").action).toBe("resume")
    expect(parseAutopilotInput("stop").action).toBe("stop")
    expect(parseAutopilotInput("stop --force").force).toBe(true)
    expect(parseAutopilotInput("Implement all issues").objective).toBe("Implement all issues")
  })
})

describe("Work Sources", () => {
  test("GitHub issues become Discovery Evidence", async () => {
    const process = new FakeProcessPort()
    process.setExit("gh", 0)
    const original = process.run.bind(process)
    process.run = async (input) => {
      const result = await original(input)
      return { ...result, stdout: JSON.stringify([{ number: 231, title: "Add pagination", body: "Paginate search." }]) }
    }
    const source = new GitHubIssueSource(process)
    const evidence = await source.discover({ objective: "Work through GitHub issues", hints: {} })
    expect(evidence[0]?.sourceKey).toBe("github:231")
    expect(evidence[0]?.title).toBe("Add pagination")
  })

  test("markdown tasks, TODOs, explicit files, and failing checks emit evidence", async () => {
    const files = new MemoryFilePort({
      "docs/plan.md": "- [ ] Migrate backend\n- [x] Done",
      "src/app.ts": "TODO: handle timeout",
    })
    const markdown = await new MarkdownTaskSource(files).discover({ hints: { pattern: "**/*.md" } })
    const todos = await new TodoSource(files).discover({ hints: { pattern: "**/*.ts" } })
    const explicit = await new ExplicitFileSource(files).discover({
      hints: { files: "docs/plan.md" },
    })
    const checks = await new RepositoryCheckSource(new FakeProcessPort({ bun: 1 })).discover({
      objective: "Fix every failing test",
      hints: {},
    })
    expect(markdown[0]?.title).toBe("Migrate backend")
    expect(todos[0]?.title).toBe("handle timeout")
    expect(explicit[0]?.sourceKey).toBe("file:docs/plan.md")
    expect(checks.some((entry) => entry.sourceKey.startsWith("check:"))).toBe(true)
  })
})
