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
  agentContribution,
  defineAgent,
  defineExtension,
  defineResource,
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
      // Per-process Resource that owns the ACP session manager's lifecycle.
      // No service is contributed (Layer.empty); the manager is closure-
      // captured by the executors above, and its disposal runs as the
      // Resource's `stop` finalizer at process scope teardown.
      //
      // Explicit `<unknown, "process">` type args widen `A` from `never`
      // (inferred from `Layer.empty`) so the Resource fits the
      // `AnyResourceContribution = ResourceContribution<any, ...>` union
      // member without TypeScript's contravariance check failing on the
      // `Layer<A, ...>` slot.
      defineResource<unknown, "process">({
        scope: "process",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        layer: Layer.empty as Layer.Layer<unknown>,
        stop: manager.disposeAll(),
      }),
    ]
  },
})
