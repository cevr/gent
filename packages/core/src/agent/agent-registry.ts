import { Context, Effect, Layer } from "effect"
import type { AgentDefinition } from "./agent-definition"
import { Agents } from "./agents"

export interface AgentRegistryService {
  readonly get: (name: string) => Effect.Effect<AgentDefinition | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly listPrimary: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly listSubagents: () => Effect.Effect<ReadonlyArray<AgentDefinition>>
  readonly register: (agent: AgentDefinition) => Effect.Effect<void>
}

export class AgentRegistry extends Context.Tag("@gent/core/src/agent/agent-registry/AgentRegistry")<
  AgentRegistry,
  AgentRegistryService
>() {
  static Live = Layer.effect(
    AgentRegistry,
    Effect.sync(() => {
      const agents = new Map<string, AgentDefinition>()
      for (const agent of Object.values(Agents)) {
        agents.set(agent.name, agent)
      }

      return AgentRegistry.of({
        get: (name) => Effect.succeed(agents.get(name)),
        list: () => Effect.succeed([...agents.values()]),
        listPrimary: () =>
          Effect.succeed(
            [...agents.values()].filter((a) => a.kind === "primary" && a.hidden !== true),
          ),
        listSubagents: () =>
          Effect.succeed([...agents.values()].filter((a) => a.kind === "subagent")),
        register: (agent) => Effect.sync(() => void agents.set(agent.name, agent)),
      })
    }),
  )
}
