import { sha256 } from "../planning/sources.js"
import type { DiscoveryEvidence, WorkSourceAdapter } from "../planning/types.js"
import type { ProcessPort } from "../verify/types.js"

export class GitHubIssueSource implements WorkSourceAdapter {
  readonly id = "github-issues"

  constructor(
    private readonly process: ProcessPort,
    private readonly cwd = ".",
  ) {}

  async discover(input: { objective: string; hints: Record<string, string> }): Promise<DiscoveryEvidence[]> {
    void input
    const result = await this.process.run({
      command: "gh",
      args: ["issue", "list", "--state", "open", "--json", "number,title,body"],
      cwd: this.cwd,
      timeoutMs: 30_000,
    })
    if (result.code !== 0) {
      return []
    }
    let issues: Array<{ number: number; title: string; body?: string }>
    try {
      issues = JSON.parse(result.stdout) as Array<{ number: number; title: string; body?: string }>
    } catch {
      return []
    }
    if (!Array.isArray(issues)) {
      return []
    }
    return issues.map((issue) => ({
      sourceId: this.id,
      sourceKey: `github:${issue.number}`,
      fingerprint: sha256(`${issue.number}:${issue.title}:${issue.body ?? ""}`),
      title: issue.title,
      body: issue.body ?? "",
      provenance: "gh issue list",
      metadata: { number: String(issue.number) },
    }))
  }
}
