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
import { Layer } from "effect"
import {
  defineAgent,
  defineExtension,
  defineResource,
  ExternalDriverRef,
  resource,
} from "@gent/core/extensions/api"
import { ACP_AGENTS } from "./config.js"
import { makeAcpTurnExecutor } from "./executor.js"
import { createAcpSessionManager } from "./session-manager.js"

// Module-scope singleton — created once at extension setup, shared across
// agents and externalDrivers factory calls.
let _sharedManager: ReturnType<typeof createAcpSessionManager> | undefined
const getManager = () => {
  if (_sharedManager === undefined) _sharedManager = createAcpSessionManager()
  return _sharedManager
}

export const AcpAgentsExtension = defineExtension({
  id: "@gent/acp-agents",
  agents: Object.entries(ACP_AGENTS).map(([name, config]) =>
    defineAgent({
      name,
      description: `${config.command} via ACP`,
      driver: new ExternalDriverRef({ id: `acp-${name}` }),
    }),
  ),
  externalDrivers: () =>
    Object.entries(ACP_AGENTS).map(([name, config]) => ({
      id: `acp-${name}`,
      executor: makeAcpTurnExecutor(config, getManager()),
    })),
  // Per-process lifecycle-only Resource that owns the ACP session
  // manager's disposal. The manager is accessed via getManager() by the
  // executors above; its `disposeAll()` runs as the Resource's `stop`
  // finalizer at process-scope teardown. No service is contributed.
  resources: () => [
    resource(
      defineResource({
        scope: "process",
        layer: Layer.empty,
        stop: getManager().disposeAll(),
      }),
    ),
  ],
})
