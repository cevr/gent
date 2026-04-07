import { extension } from "./api.js"
import { Agents } from "../domain/agent.js"

export const AgentsExtension = extension("@gent/agents", ({ ext }) =>
  ext.agents(...Object.values(Agents)),
)
