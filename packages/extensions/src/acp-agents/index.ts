/**
 * ACP Agents Extension — external agents (Claude Code, OpenCode, Gemini CLI)
 * as first-class gent agents via the TurnExecutor primitive.
 *
 * The "session manager" here is a per-extension subprocess + ACP-session
 * cache, not a state machine with declared effects. It survives this commit
 * unchanged (no `WorkflowContribution` is appropriate); C9 collapses
 * `TurnExecutor` into `ExternalDriverContribution`. What C8d does is the
 * structural lift: `extension(...).agents().turnExecutor().onShutdown()` →
 * `defineExtension({ id, contributions: [...] })`.
 *
 * @module
 */
import {
  agentContribution,
  defineAgent,
  defineExtension,
  ExternalExecution,
  onShutdownContribution,
  turnExecutorContribution,
} from "@gent/core/extensions/api"
import { ACP_AGENTS } from "./config.js"
import { makeAcpTurnExecutor } from "./executor.js"
import { createAcpSessionManager } from "./session-manager.js"

export const AcpAgentsExtension = defineExtension({
  id: "@gent/acp-agents",
  contributions: () => {
    const manager = createAcpSessionManager()

    return [
      ...Object.entries(ACP_AGENTS).map(([name, config]) =>
        agentContribution(
          defineAgent({
            name,
            description: `${config.command} via ACP`,
            persistence: "ephemeral",
            execution: new ExternalExecution({ runnerId: `acp-${name}` }),
          }),
        ),
      ),
      ...Object.entries(ACP_AGENTS).map(([name, config]) =>
        turnExecutorContribution({
          id: `acp-${name}`,
          executor: makeAcpTurnExecutor(config, manager),
        }),
      ),
      onShutdownContribution(manager.disposeAll()),
    ]
  },
})
