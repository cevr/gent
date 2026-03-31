import { extension } from "./api.js"
import { Agents } from "../domain/agent.js"

export const AgentsExtension = extension("@gent/agents", (ext) => {
  for (const agent of Object.values(Agents)) {
    ext.agent(agent)
  }
})
