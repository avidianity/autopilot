export interface VerificationCheck {
  id: string
  command: string
  args: string[]
  timeoutMs: number
  cwd: "worktree" | "integration"
  expectedExitCode: number
}

export interface VerificationPlan {
  workItemId: string
  checks: readonly VerificationCheck[]
  requireSemantic: boolean
}

export interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export interface ProcessPort {
  run(input: {
    command: string
    args: string[]
    cwd: string
    timeoutMs: number
  }): Promise<ProcessResult>
}

export interface GitPort {
  available(): boolean
  head(cwd: string): string
  commitsSince(base: string, cwd: string): string[]
  cherryPick(commits: string[], cwd: string): void
  revertCherryPick(cwd: string, toSha?: string): void
}

export interface VerificationCheckResult {
  id: string
  success: boolean
  code: number
  output: string
  baselineFailure: boolean
}

export interface VerificationResult {
  success: boolean
  checks: VerificationCheckResult[]
  reason?: string
  suggestedRepair?: string
}
