/**
 * ACP Agents Extension — external agents (Claude Code, OpenCode, Gemini CLI)
 * as first-class gent agents via the TurnExecutor primitive.
 *
 * @module
 */
import { extension, defineAgent, ExternalExecution } from "@gent/core/extensions/api"
import { ACP_AGENTS } from "./config.js"
import { makeAcpTurnExecutor } from "./executor.js"
import { createAcpSessionManager } from "./session-manager.js"

export const AcpAgentsExtension = extension("@gent/acp-agents", ({ ext }) => {
  const manager = createAcpSessionManager()

  // Build all agent defs upfront — .agents() is single-call (guardSingle)
  const agentDefs = Object.entries(ACP_AGENTS).map(([name, config]) =>
    defineAgent({
      name,
      description: `${config.command} via ACP`,
      persistence: "ephemeral",
      execution: new ExternalExecution({ runnerId: `acp-${name}` }),
    }),
  )

  // Register agents (single call) then turn executors (multi-call)
  let builder = ext.agents(...agentDefs)
  for (const [name, config] of Object.entries(ACP_AGENTS)) {
    builder = builder.turnExecutor(`acp-${name}`, makeAcpTurnExecutor(config, manager))
  }

  return builder.onShutdownEffect(manager.disposeAll())
})
