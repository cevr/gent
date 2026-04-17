/**
 * ACP Agents Extension — external agents (Claude Code, OpenCode, Gemini CLI)
 * as first-class gent agents via the ExternalDriver primitive.
 *
 * The "session manager" here is a per-extension subprocess + ACP-session
 * cache, not a state machine with declared effects — no `WorkflowContribution`
 * is appropriate. C9 collapses the old `TurnExecutor` slot into
 * `ExternalDriverContribution`; agents reference the driver via
 * `driver: new ExternalDriverRef({ id: "acp-<name>" })`.
 *
 * @module
 */
import {
  agentContribution,
  defineAgent,
  defineExtension,
  defineLifecycleResource,
  ExternalDriverRef,
  externalDriverContribution,
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
            driver: new ExternalDriverRef({ id: `acp-${name}` }),
          }),
        ),
      ),
      ...Object.entries(ACP_AGENTS).map(([name, config]) =>
        externalDriverContribution({
          id: `acp-${name}`,
          executor: makeAcpTurnExecutor(config, manager),
        }),
      ),
      // Per-process lifecycle-only Resource that owns the ACP session
      // manager's disposal. The manager is closure-captured by the
      // executors above; its `disposeAll()` runs as the Resource's `stop`
      // finalizer at process-scope teardown. No service is contributed.
      defineLifecycleResource({
        scope: "process",
        stop: manager.disposeAll(),
      }),
    ]
  },
})
