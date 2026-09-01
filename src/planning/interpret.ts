import type { SourceSelection } from "./types.js"

const FILE_PATH = /(?:^|\s)((?:\.\/)?[\w./-]+\.[A-Za-z][\w]*)/g

export function selectWorkSourcesFromObjective(objective: string): SourceSelection[] {
  const sources: SourceSelection[] = [
    {
      id: "direct-objective",
      rank: 1,
      reason: "always include the Autopilot Objective",
      hints: {},
    },
  ]
  let rank = 2
  const lower = objective.toLowerCase()
  const push = (id: string, reason: string, hints: Record<string, string> = {}): void => {
    if (sources.some((source) => source.id === id)) {
      return
    }
    sources.push({ id, rank, reason, hints })
    rank += 1
  }
  if (/\bgithub\b/.test(lower) || /\bissues?\b/.test(lower)) {
    push("github-issues", "objective names GitHub or issues")
  }
  if (/\btest\b/.test(lower) || /\blint\b/.test(lower) || /\btypecheck\b/.test(lower) || /\bbuild\b/.test(lower)) {
    push("repository-checks", "objective names repository checks")
  }
  if (/\btodo\b/.test(lower)) {
    push("repository-todos", "objective names todos")
  }
  if (/\bmarkdown\b/.test(lower) || /\bplan\b/.test(lower) || /\bdocs\b/.test(lower)) {
    push("markdown-tasks", "objective names markdown, plan, or docs", { pattern: "**/*.md" })
  }
  const files: string[] = []
  for (const match of objective.matchAll(FILE_PATH)) {
    const path = match[1]
    if (path && !path.startsWith("http")) {
      files.push(path)
    }
  }
  if (files.length > 0) {
    push("explicit-files", "objective names file paths", { files: files.join(",") })
  }
  return sources
}
