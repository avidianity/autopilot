import { runValidated } from "./semantic-engine.js"
import type { Capability, SemanticEngine, WorkerInstruction } from "./types.js"

export async function compileWorkerInstruction(input: {
  engine: SemanticEngine
  objective: string
  workItem: { id: string; title: string; objective: string }
  capabilities: readonly Capability[]
  retryLimit?: number
}): Promise<WorkerInstruction> {
  const fallback: WorkerInstruction = {
    prompt: [
      "AUTOPILOT GLOBAL OBJECTIVE",
      input.objective,
      "",
      "THIS WORK ITEM",
      input.workItem.title,
      input.workItem.objective,
      "",
      "Follow the global objective constraints (tools, plugins, identity, repo, review gates, model).",
      "Use available tools in this session, including the task tool when the objective asks for subagents.",
      "Do not work on unrelated Work Items.",
      "Do not decide whether the Autopilot Run should stop.",
    ].join("\n"),
  }
  try {
    const result = await runValidated(
      input.engine,
      {
        operation: "compile-instruction",
        objective: input.objective,
        workItem: input.workItem,
        capabilities: [...input.capabilities],
      },
      input.retryLimit ?? 2,
    )
    if (result.operation !== "compile-instruction") {
      return fallback
    }
    const instruction = result.instruction
    if (instruction.command && instruction.capabilityId && instruction.fitEvidence) {
      const capability = input.capabilities.find((entry) => entry.id === instruction.capabilityId)
      if (capability) {
        return {
          command: instruction.command,
          capabilityId: capability.id,
          fitEvidence: instruction.fitEvidence,
        }
      }
    }
    if (instruction.prompt) {
      return { prompt: instruction.prompt }
    }
    return fallback
  } catch {
    return fallback
  }
}
