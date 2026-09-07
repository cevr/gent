import type { AgentDefinition } from "@gent/core/extensions/api"
import { CoreAgents } from "../../src/agents.js"
import { librarian } from "../../src/librarian/index.js"

export const AllBuiltinAgents: ReadonlyArray<AgentDefinition> = [...CoreAgents, librarian]

export const getBuiltinAgent = (name: string) =>
  AllBuiltinAgents.find((agent) => agent.name === name)
