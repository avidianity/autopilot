import type { SemanticRequest, SemanticResult } from "./types.js"

export class SemanticValidationError extends Error {
  override readonly name = "SemanticValidationError"

  constructor(message: string) {
    super(message)
  }
}

export function assertSemanticResult(
  request: SemanticRequest,
  value: unknown,
): SemanticResult {
  if (!isObject(value) || value.operation !== request.operation) {
    throw new SemanticValidationError("operation mismatch")
  }
  if (request.operation === "interpret-objective") {
    if (!Array.isArray(value.sources)) {
      throw new SemanticValidationError("missing sources")
    }
    for (const source of value.sources) {
      if (
        !isObject(source) ||
        typeof source.id !== "string" ||
        typeof source.rank !== "number" ||
        typeof source.reason !== "string" ||
        !isObject(source.hints)
      ) {
        throw new SemanticValidationError("invalid source selection")
      }
    }
    return value as unknown as SemanticResult
  }
  if (request.operation === "propose-plan") {
    if (!Array.isArray(value.items)) {
      throw new SemanticValidationError("missing items")
    }
    for (const item of value.items) {
      if (
        !isObject(item) ||
        typeof item.sourceKey !== "string" ||
        typeof item.title !== "string" ||
        typeof item.objective !== "string" ||
        !Array.isArray(item.dependencies)
      ) {
        throw new SemanticValidationError("invalid plan item")
      }
    }
    return value as unknown as SemanticResult
  }
  if (request.operation === "compile-instruction") {
    if (!isObject(value.instruction)) {
      throw new SemanticValidationError("missing instruction")
    }
    return value as unknown as SemanticResult
  }
  if (typeof value.accepted !== "boolean") {
    throw new SemanticValidationError("missing accepted")
  }
  return value as unknown as SemanticResult
}

export async function runValidated(
  engine: { run(request: SemanticRequest): Promise<SemanticResult> },
  request: SemanticRequest,
  retryLimit: number,
): Promise<SemanticResult> {
  let lastError: unknown
  const attempts = Math.max(1, retryLimit)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await engine.run(request)
      return assertSemanticResult(request, result)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new SemanticValidationError("invalid semantic output")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
