import { spawnSync } from "node:child_process"
import { isAbsolute, resolve } from "node:path"

import type { GitPort } from "./types.js"

export class RealGitPort implements GitPort {
  constructor(private readonly root: string) {}

  private cwd(path: string): string {
    return isAbsolute(path) ? path : resolve(this.root, path)
  }

  available(): boolean {
    const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: this.root,
      encoding: "utf8",
    })
    return result.status === 0 && result.stdout.trim() === "true"
  }

  head(cwd: string): string {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: this.cwd(cwd),
      encoding: "utf8",
    })
    return result.status === 0 ? result.stdout.trim() : ""
  }

  commitsSince(base: string, cwd: string): string[] {
    if (!base || base === "HEAD") {
      return []
    }
    const result = spawnSync("git", ["log", "--reverse", "--format=%H", `${base}..HEAD`], {
      cwd: this.cwd(cwd),
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
      cwd: this.cwd(cwd),
      encoding: "utf8",
    })
    if (result.status !== 0) {
      throw new Error(result.stderr || "cherry-pick failed")
    }
  }

  revertCherryPick(cwd: string, toSha?: string): void {
    if (toSha) {
      const reset = spawnSync("git", ["reset", "--hard", toSha], {
        cwd: this.cwd(cwd),
        encoding: "utf8",
      })
      if (reset.status !== 0) {
        throw new Error(reset.stderr || "reset --hard failed")
      }
      return
    }
    spawnSync("git", ["cherry-pick", "--abort"], { cwd: this.cwd(cwd), encoding: "utf8" })
  }
}

export class FakeGitPort implements GitPort {
  commits: string[] = ["abc123"]
  cherryPickShouldFail = false
  reverted = false
  enabled = true
  lastRange: { base: string; cwd: string } | undefined
  headSha = "base-sha"
  applied: string[] = []
  private pickInProgress = false

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
    void cwd
    if (this.cherryPickShouldFail) {
      this.pickInProgress = true
      throw new Error("conflict")
    }
    this.pickInProgress = false
    this.applied = [...commits]
    this.headSha = commits[commits.length - 1] ?? this.headSha
  }

  revertCherryPick(cwd: string, toSha?: string): void {
    void cwd
    this.reverted = true
    if (toSha) {
      this.headSha = toSha
      this.applied = []
      this.pickInProgress = false
      return
    }
    if (this.pickInProgress) {
      this.pickInProgress = false
    }
  }
}
