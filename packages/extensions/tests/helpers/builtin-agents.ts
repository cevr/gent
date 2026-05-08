import type { AgentDefinition } from "@gent/core/extensions/api"
import { CoreAgents } from "../../src/agents.js"
import { auditor } from "../../src/audit/index.js"
import { librarian } from "../../src/librarian/index.js"
import { architect } from "../../src/research/index.js"

export const AllBuiltinAgents: ReadonlyArray<AgentDefinition> = [
  ...CoreAgents,
  architect,
  auditor,
  librarian,
]

export const getBuiltinAgent = (name: string): AgentDefinition | undefined =>
  AllBuiltinAgents.find((agent) => agent.name === name)
