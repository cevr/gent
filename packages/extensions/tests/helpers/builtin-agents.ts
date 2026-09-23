import type { AgentDefinition } from "@gent/core/extensions/api"
import { main } from "../../src/agents.js"

/** The shipped agent. Tests that need a second agent define one locally. */
export const builtinAgent: AgentDefinition = main
