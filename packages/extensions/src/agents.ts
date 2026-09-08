import { Effect } from "effect"
import {
  AgentDefinition,
  AgentName,
  defineExtension,
  ExtensionHost,
} from "@gent/core/extensions/api"

/**
 * The one shipped agent. Its prompt is the base system prompt; its model is
 * `DEFAULT_MODEL_ID`. Children spawned from a cell inherit it, so there is
 * no roster of role agents to pick from.
 */
export const main = AgentDefinition.make({
  name: AgentName.make("main"),
  description: "General purpose agent that solves tasks with code in the cell",
  reasoningEffort: "max",
})

export const CoreAgents = [main] satisfies ReadonlyArray<AgentDefinition>

export const AgentsExtension = defineExtension({
  id: "@gent/agents",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("agent", ...CoreAgents)
  }),
})
