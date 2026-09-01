import type { GitPort } from "./types.js"

export class FakeGitPort implements GitPort {
  commits: string[] = ["abc123"]
  cherryPickShouldFail = false
  reverted = false
  enabled = true

  available(): boolean {
    return this.enabled
  }

  commitsSince(base: string, cwd: string): string[] {
    void base
    void cwd
    return [...this.commits]
  }

  cherryPick(commits: string[], cwd: string): void {
    void commits
    void cwd
    if (this.cherryPickShouldFail) {
      throw new Error("conflict")
    }
  }

  revertCherryPick(cwd: string): void {
    void cwd
    this.reverted = true
  }
}
