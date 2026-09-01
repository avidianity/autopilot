import { runValidated } from "./semantic-engine.js"
import type { WorkSourceRegistry } from "./sources.js"
import type { DiscoveryEvidence, SemanticEngine } from "./types.js"

export async function discoverEvidence(input: {
  objective: string
  engine: SemanticEngine
  registry: WorkSourceRegistry
  retryLimit?: number
}): Promise<DiscoveryEvidence[]> {
  const interpreted = await runValidated(
    input.engine,
    { operation: "interpret-objective", objective: input.objective },
    input.retryLimit ?? 2,
  )
  if (interpreted.operation !== "interpret-objective") {
    return []
  }
  const selected = [...interpreted.sources].sort((left, right) => left.rank - right.rank)
  const evidence: DiscoveryEvidence[] = []
  for (const source of selected) {
    const adapter = input.registry.get(source.id)
    if (!adapter) {
      continue
    }
    evidence.push(
      ...(await adapter.discover({
        objective: input.objective,
        hints: source.hints,
      })),
    )
  }
  return evidence
}
