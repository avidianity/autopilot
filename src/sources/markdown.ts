import { sha256 } from "../planning/sources.js"
import type { DiscoveryEvidence, WorkSourceAdapter } from "../planning/types.js"

export interface FilePort {
  read(path: string): Promise<string | undefined>
  list(pattern: string): Promise<string[]>
}

export class MarkdownTaskSource implements WorkSourceAdapter {
  readonly id = "markdown-tasks"

  constructor(private readonly files: FilePort) {}

  async discover(input: { hints: Record<string, string> }): Promise<DiscoveryEvidence[]> {
    const pattern = input.hints.pattern ?? "**/*.md"
    const paths = await this.files.list(pattern)
    const evidence: DiscoveryEvidence[] = []
    for (const path of paths) {
      const body = await this.files.read(path)
      if (!body) {
        continue
      }
      const matches = body.matchAll(/^[-*] \[ \] (.+)$/gm)
      for (const match of matches) {
        const title = match[1]?.trim()
        if (!title) {
          continue
        }
        evidence.push({
          sourceId: this.id,
          sourceKey: `markdown:${path}:${title}`,
          fingerprint: sha256(`${path}:${title}`),
          title,
          body: title,
          provenance: path,
          metadata: { path },
        })
      }
    }
    return evidence
  }
}

export class TodoSource implements WorkSourceAdapter {
  readonly id = "repository-todos"

  constructor(private readonly files: FilePort) {}

  async discover(input: { hints: Record<string, string> }): Promise<DiscoveryEvidence[]> {
    const pattern = input.hints.pattern ?? "**/*.{ts,tsx,js,md}"
    const paths = await this.files.list(pattern)
    const evidence: DiscoveryEvidence[] = []
    for (const path of paths) {
      const body = await this.files.read(path)
      if (!body) {
        continue
      }
      const matches = body.matchAll(/TODO[:\s]+(.+)$/gm)
      for (const match of matches) {
        const title = match[1]?.trim()
        if (!title) {
          continue
        }
        evidence.push({
          sourceId: this.id,
          sourceKey: `todo:${path}:${title}`,
          fingerprint: sha256(`${path}:${title}`),
          title,
          body: title,
          provenance: path,
          metadata: { path },
        })
      }
    }
    return evidence
  }
}

export class ExplicitFileSource implements WorkSourceAdapter {
  readonly id = "explicit-files"

  constructor(private readonly files: FilePort) {}

  async discover(input: { hints: Record<string, string> }): Promise<DiscoveryEvidence[]> {
    const listed = input.hints.files
    if (!listed) {
      return []
    }
    const evidence: DiscoveryEvidence[] = []
    for (const path of listed.split(",").map((entry) => entry.trim()).filter(Boolean)) {
      const body = (await this.files.read(path)) ?? ""
      evidence.push({
        sourceId: this.id,
        sourceKey: `file:${path}`,
        fingerprint: sha256(`${path}:${body}`),
        title: path,
        body,
        provenance: path,
        metadata: { path },
      })
    }
    return evidence
  }
}

export class MemoryFilePort implements FilePort {
  constructor(private readonly files: Record<string, string>) {}

  async read(path: string): Promise<string | undefined> {
    return this.files[path]
  }

  async list(pattern: string): Promise<string[]> {
    const suffix = pattern.includes(".md") ? ".md" : undefined
    return Object.keys(this.files).filter((path) => (suffix ? path.endsWith(suffix) : true))
  }
}
