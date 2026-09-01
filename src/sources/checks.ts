import { sha256 } from "../planning/sources.js"
import type { DiscoveryEvidence, WorkSourceAdapter } from "../planning/types.js"
import type { ProcessPort } from "../verify/types.js"

const CHECKS = [
  { id: "tests", command: "bun", args: ["test"] },
  { id: "lint", command: "bun", args: ["run", "lint"] },
  { id: "typecheck", command: "bun", args: ["run", "typecheck"] },
  { id: "build", command: "bun", args: ["run", "build"] },
] as const

export class RepositoryCheckSource implements WorkSourceAdapter {
  readonly id = "repository-checks"

  constructor(private readonly process: ProcessPort) {}

  async discover(input: { objective: string; hints: Record<string, string> }): Promise<DiscoveryEvidence[]> {
    void input
    const evidence: DiscoveryEvidence[] = []
    for (const check of CHECKS) {
      const result = await this.process.run({
        command: check.command,
        args: [...check.args],
        cwd: ".",
        timeoutMs: 120_000,
      })
      if (result.code === 0) {
        continue
      }
      evidence.push({
        sourceId: this.id,
        sourceKey: `check:${check.id}`,
        fingerprint: sha256(`${check.id}:${result.stderr}:${result.stdout}`),
        title: `Fix failing ${check.id}`,
        body: `${result.stdout}\n${result.stderr}`.trim(),
        provenance: check.id,
        metadata: { command: [check.command, ...check.args].join(" ") },
      })
    }
    return evidence
  }
}
