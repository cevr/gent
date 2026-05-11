/**
 * Pure helper that resolves an agent by name through the already-exposed
 * `Agent.get` data primitive on `ExtensionContext`. Fails with a typed
 * `ExtensionServiceError` when the agent is not registered.
 *
 * Replaces the previous `Agent.require` method that was duplicated across
 * `ExtensionHostContext.Agent`, `ExtensionAgentService`, the host-context
 * factory, and two test stubs. Composes over `Agent.get` instead.
 */

import { Effect } from "effect"
import type { AgentDefinition, AgentName } from "./agent.js"
import { ExtensionContext, ExtensionServiceError } from "./extension-services.js"

export const requireAgent = (
  name: AgentName,
): Effect.Effect<AgentDefinition, ExtensionServiceError, ExtensionContext> =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const agent = yield* ctx.Agent.get(name)
    if (agent !== undefined) return agent
    return yield* new ExtensionServiceError({
      service: "ExtensionAgent",
      operation: "require",
      message: `Agent "${name}" not found in registry`,
    })
  })
