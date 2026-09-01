import { assertSemanticResult } from "./semantic-engine.js"
import type { SemanticEngine, SemanticRequest, SemanticResult } from "./types.js"

export interface CompletionPort {
  complete(prompt: string): Promise<string>
}

export class OpenCodeSemanticEngine implements SemanticEngine {
  constructor(private readonly completions: CompletionPort) {}

  async run(request: SemanticRequest): Promise<SemanticResult> {
    const raw = await this.completions.complete(JSON.stringify(request))
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      throw new Error("Semantic Engine returned non-JSON")
    }
    return assertSemanticResult(request, parsed)
  }
}
