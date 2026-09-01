import type { AutopilotStore } from "../core/store.js"
import type { WorkItemRecord } from "../core/types.js"
import { runValidated, SemanticValidationError } from "./semantic-engine.js"
import type {
  DiscoveryEvidence,
  PlanItemProposal,
  ProposePlanResult,
  SemanticEngine,
} from "./types.js"

const EXECUTING = new Set(["launching", "running", "verifying", "integrating", "repairing"])

export function applyPlan(input: {
  store: AutopilotStore
  runId: string
  fencingToken: number
  proposal: ProposePlanResult
}): WorkItemRecord[] {
  assertNoCycles(input.proposal.items)
  const current = input.store.snapshot(input.runId).workItems
  return input.store.mutate(input.runId, input.fencingToken, (tx) => {
    const applied: WorkItemRecord[] = []
    for (const item of input.proposal.items) {
      const existing = current.find((entry) => entry.sourceKey === item.sourceKey)
      if (existing && EXECUTING.has(existing.status)) {
        applied.push(existing)
        continue
      }
      if (
        existing?.status === "completed" &&
        (item.contentFingerprint === undefined ||
          item.contentFingerprint === existing.contentFingerprint)
      ) {
        applied.push(existing)
        continue
      }
      const record = tx.upsertWorkItem({
        title: item.title,
        objective: item.objective,
        sourceKey: item.sourceKey,
        dependencies: item.dependencies,
        ...(item.contentFingerprint ? { contentFingerprint: item.contentFingerprint } : {}),
      })
      if (record.status === "pending") {
        if (item.blocked || item.dependencies.length > 0) {
          applied.push(tx.transitionWorkItem(record.id, "blocked", item.blockedReason ?? "blocked"))
        } else {
          applied.push(tx.transitionWorkItem(record.id, "ready", "unblocked"))
        }
      } else {
        applied.push(record)
      }
    }
    return applied
  })
}

export function unblockReadyWorkItems(input: {
  store: AutopilotStore
  runId: string
  fencingToken: number
}): WorkItemRecord[] {
  const items = input.store.snapshot(input.runId).workItems
  return input.store.mutate(input.runId, input.fencingToken, (tx) => {
    const released: WorkItemRecord[] = []
    for (const item of items) {
      if (item.status !== "blocked") {
        continue
      }
      if (item.sourceKey === "diagnostic:semantic-plan") {
        continue
      }
      if (item.dependencies.length > 0 && !dependenciesCompleted(item, items)) {
        continue
      }
      released.push(tx.transitionWorkItem(item.id, "ready", "dependencies completed"))
    }
    return released
  })
}

export function dependenciesCompleted(item: WorkItemRecord, items: WorkItemRecord[]): boolean {
  return item.dependencies.every((dependency) =>
    items.some(
      (candidate) =>
        candidate.status === "completed" &&
        (candidate.id === dependency || candidate.sourceKey === dependency),
    ),
  )
}

export async function applyPlanFromEngine(input: {
  store: AutopilotStore
  runId: string
  fencingToken: number
  engine: SemanticEngine
  objective: string
  evidence: DiscoveryEvidence[]
  prior: Array<{ sourceKey?: string; status: string }>
  retryLimit?: number
}): Promise<WorkItemRecord[]> {
  try {
    const proposal = await runValidated(
      input.engine,
      {
        operation: "propose-plan",
        objective: input.objective,
        evidence: input.evidence,
        prior: input.prior,
      },
      input.retryLimit ?? 2,
    )
    if (proposal.operation !== "propose-plan") {
      throw new SemanticValidationError("missing items")
    }
    const fingerprints = new Map(input.evidence.map((entry) => [entry.sourceKey, entry.fingerprint]))
    return applyPlan({
      store: input.store,
      runId: input.runId,
      fencingToken: input.fencingToken,
      proposal: {
        ...proposal,
        items: proposal.items.map((item) => {
          const fingerprint = item.contentFingerprint ?? fingerprints.get(item.sourceKey)
          return fingerprint ? { ...item, contentFingerprint: fingerprint } : item
        }),
      },
    })
  } catch {
    return applyPlan({
      store: input.store,
      runId: input.runId,
      fencingToken: input.fencingToken,
      proposal: {
        operation: "propose-plan",
        items: [
          {
            sourceKey: "diagnostic:semantic-plan",
            title: "Clarify Autopilot Objective",
            objective: "Semantic planning failed validation. Supervisor remains enabled.",
            dependencies: [],
            blocked: true,
            blockedReason: "invalid semantic output",
          },
        ],
      },
    })
  }
}

function assertNoCycles(items: PlanItemProposal[]): void {
  const graph = new Map(items.map((item) => [item.sourceKey, item.dependencies]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (node: string): void => {
    if (visited.has(node)) {
      return
    }
    if (visiting.has(node)) {
      throw new Error("dependency cycle")
    }
    visiting.add(node)
    for (const next of graph.get(node) ?? []) {
      if (graph.has(next)) {
        visit(next)
      }
    }
    visiting.delete(node)
    visited.add(node)
  }

  for (const key of graph.keys()) {
    visit(key)
  }
}
