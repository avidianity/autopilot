import type { Capability, CapabilityCatalogInput } from "./types.js"

export function buildCapabilitySnapshot(input: CapabilityCatalogInput): Capability[] {
  return Object.freeze(
    [
      ...input.commands.map((entry) => ({
        id: entry.id,
        description: entry.description,
        provenance: entry.provenance,
        kind: "command" as const,
        invocation: entry.invocation,
        ...(entry.constraints ? { constraints: [...entry.constraints] } : {}),
      })),
      ...input.skills.map((entry) => ({
        id: entry.id,
        description: entry.description,
        provenance: entry.provenance,
        kind: "skill" as const,
        invocation: { kind: "prompt" as const },
        ...(entry.constraints ? { constraints: [...entry.constraints] } : {}),
      })),
      ...input.agents.map((entry) => ({
        id: entry.id,
        description: entry.description,
        provenance: entry.provenance,
        kind: "agent" as const,
        invocation: { kind: "agent" as const },
        ...(entry.constraints ? { constraints: [...entry.constraints] } : {}),
      })),
      ...input.tools.map((entry) => ({
        id: entry.id,
        description: entry.description,
        provenance: entry.provenance,
        kind: "tool" as const,
        invocation: { kind: "tool" as const },
        ...(entry.constraints ? { constraints: [...entry.constraints] } : {}),
      })),
      ...input.mcp.map((entry) => ({
        id: entry.id,
        description: entry.description,
        provenance: entry.provenance,
        kind: "mcp" as const,
        invocation: { kind: "tool" as const },
        ...(entry.constraints ? { constraints: [...entry.constraints] } : {}),
      })),
      ...input.repository.map((entry) => ({
        id: entry.id,
        description: entry.description,
        provenance: entry.provenance,
        kind: "repository" as const,
        invocation: { kind: "prompt" as const },
        ...(entry.constraints ? { constraints: [...entry.constraints] } : {}),
      })),
    ].map((capability) => Object.freeze(capability)),
  ) as Capability[]
}
