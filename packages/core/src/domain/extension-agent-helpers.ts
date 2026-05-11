import { Effect } from "effect"
import type { AgentDefinition, AgentName } from "./agent.js"
import { ExtensionContext, ExtensionServiceError } from "./extension-services.js"

export const requireAgent = (
  name: AgentName,
): Effect.Effect<AgentDefinition, ExtensionServiceError, ExtensionContext> =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const agents = yield* ctx.Agent.listAgents()
    const agent = agents.find((a) => a.name === name)
    if (agent !== undefined) return agent
    return yield* new ExtensionServiceError({
      service: "ExtensionAgent",
      operation: "require",
      message: `Agent "${name}" not found in registry`,
    })
  })
