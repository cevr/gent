import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { Agents } from "../domain/agent.js"

export const AgentsExtension = defineExtension({
  manifest: { id: "@gent/agents" },
  setup: () =>
    Effect.succeed({
      agents: Object.values(Agents),
    }),
})
