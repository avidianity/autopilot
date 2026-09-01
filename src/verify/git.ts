import { spawnSync } from "node:child_process"

import type { GitPort } from "./types.js"

export class RealGitPort implements GitPort {
  constructor(private readonly root: string) {}

  available(): boolean {
    const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: this.root,
      encoding: "utf8",
    })
    return result.status === 0 && result.stdout.trim() === "true"
  }

  head(cwd: string): string {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    })
    return result.status === 0 ? result.stdout.trim() : ""
  }

  commitsSince(base: string, cwd: string): string[] {
    if (!base || base === "HEAD") {
      return []
    }
    const result = spawnSync("git", ["log", "--reverse", "--format=%H", `${base}..HEAD`], {
      cwd,
      encoding: "utf8",
    })
    if (result.status !== 0) {
      return []
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  }

  cherryPick(commits: string[], cwd: string): void {
    const result = spawnSync("git", ["cherry-pick", ...commits], {
      cwd,
      encoding: "utf8",
    })
    if (result.status !== 0) {
      throw new Error(result.stderr || "cherry-pick failed")
    }
  }

  revertCherryPick(cwd: string): void {
    spawnSync("git", ["cherry-pick", "--abort"], { cwd, encoding: "utf8" })
  }
}

export class FakeGitPort implements GitPort {
  commits: string[] = ["abc123"]
  cherryPickShouldFail = false
  reverted = false
  enabled = true
  lastRange: { base: string; cwd: string } | undefined
  headSha = "base-sha"

  available(): boolean {
    return this.enabled
  }

  head(cwd: string): string {
    void cwd
    return this.headSha
  }

  commitsSince(base: string, cwd: string): string[] {
    this.lastRange = { base, cwd }
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
