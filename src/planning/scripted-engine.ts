import { assertSemanticResult } from "./semantic-engine.js"
import type { SemanticEngine, SemanticRequest, SemanticResult } from "./types.js"

type Script =
  | SemanticResult
  | ((request: SemanticRequest) => SemanticResult | Promise<SemanticResult>)

export class ScriptedSemanticEngine implements SemanticEngine {
  constructor(private readonly scripts: Partial<Record<SemanticRequest["operation"], Script>>) {}

  async run(request: SemanticRequest): Promise<SemanticResult> {
    const script = this.scripts[request.operation]
    if (!script) {
      throw new Error(`no script for ${request.operation}`)
    }
    const value = typeof script === "function" ? await script(request) : script
    return assertSemanticResult(request, value)
  }
}
