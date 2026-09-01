export interface SourceSelection {
  id: string
  rank: number
  reason: string
  hints: Record<string, string>
}

export interface DiscoveryEvidence {
  sourceId: string
  sourceKey: string
  fingerprint: string
  title: string
  body: string
  provenance: string
  metadata: Record<string, string>
}

export interface WorkSourceAdapter {
  id: string
  discover(input: { objective: string; hints: Record<string, string> }): Promise<DiscoveryEvidence[]>
}

export interface PlanItemProposal {
  sourceKey: string
  title: string
  objective: string
  dependencies: string[]
  contentFingerprint?: string
  blocked?: boolean
  blockedReason?: string
}

export interface InterpretResult {
  operation: "interpret-objective"
  sources: SourceSelection[]
}

export interface ProposePlanResult {
  operation: "propose-plan"
  items: PlanItemProposal[]
}

export interface WorkerInstruction {
  command?: string
  prompt?: string
  workingDirectory?: string
  capabilityId?: string
  fitEvidence?: string
}

export interface CompileInstructionResult {
  operation: "compile-instruction"
  instruction: WorkerInstruction
}

export interface VerifyAcceptanceResult {
  operation: "verify-acceptance"
  accepted: boolean
  reason?: string
}

export type SemanticRequest =
  | { operation: "interpret-objective"; objective: string }
  | {
      operation: "propose-plan"
      objective: string
      evidence: DiscoveryEvidence[]
      prior: Array<{ sourceKey?: string; status: string }>
    }
  | {
      operation: "compile-instruction"
      objective: string
      workItem: { id: string; title: string; objective: string }
      capabilities: Capability[]
    }
  | {
      operation: "verify-acceptance"
      workItem: { id: string; title: string; objective: string }
      observations: Record<string, string>
    }

export type SemanticResult =
  | InterpretResult
  | ProposePlanResult
  | CompileInstructionResult
  | VerifyAcceptanceResult

export interface SemanticEngine {
  run(request: SemanticRequest): Promise<SemanticResult>
}

export type CapabilityKind = "command" | "skill" | "agent" | "tool" | "mcp" | "repository"

export interface Capability {
  id: string
  description: string
  provenance: string
  kind: CapabilityKind
  invocation: {
    kind: "command" | "prompt" | "tool" | "agent"
    template?: string
  }
  constraints?: string[]
}

export interface CapabilityCatalogInput {
  commands: Array<{
    id: string
    description: string
    provenance: string
    invocation: { kind: "command"; template: string }
    constraints?: string[]
  }>
  skills: Array<{
    id: string
    description: string
    provenance: string
    constraints?: string[]
  }>
  agents: Array<{
    id: string
    description: string
    provenance: string
    constraints?: string[]
  }>
  tools: Array<{
    id: string
    description: string
    provenance: string
    constraints?: string[]
  }>
  mcp: Array<{
    id: string
    description: string
    provenance: string
    constraints?: string[]
  }>
  repository: Array<{
    id: string
    description: string
    provenance: string
    constraints?: string[]
  }>
}
