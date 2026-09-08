import type { AgentDefinition } from "@gent/core/extensions/api"
import { CoreAgents, main } from "../../src/agents.js"

export const AllBuiltinAgents: ReadonlyArray<AgentDefinition> = [...CoreAgents]

/** The shipped agent. Tests that need a second agent define one locally. */
export const builtinAgent: AgentDefinition = main

export const getBuiltinAgent = (name: string) =>
  AllBuiltinAgents.find((agent) => agent.name === name)
