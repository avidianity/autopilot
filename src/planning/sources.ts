import { createHash } from "node:crypto"

import type { DiscoveryEvidence, WorkSourceAdapter } from "./types.js"

export class WorkSourceRegistry {
  private readonly adapters = new Map<string, WorkSourceAdapter>()

  register(adapter: WorkSourceAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): WorkSourceAdapter | undefined {
    return this.adapters.get(id)
  }
}

export class DirectObjectiveSource implements WorkSourceAdapter {
  readonly id = "direct-objective"

  async discover(input: { objective: string; hints: Record<string, string> }): Promise<DiscoveryEvidence[]> {
    const sourceKey = `${this.id}:${input.objective}`
    return [
      {
        sourceId: this.id,
        sourceKey,
        fingerprint: sha256(input.objective),
        title: input.objective,
        body: input.objective,
        provenance: "autopilot-objective",
        metadata: input.hints,
      },
    ]
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
