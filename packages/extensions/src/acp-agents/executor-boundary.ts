/**
 * Boundary helper for {@link createAcpTurnExecutor}.
 *
 * The MCP Codemode `runTool` callback hands tool invocations to a JS sandbox;
 * that sandbox is a Promise-returning host. Core owns actual tool execution and
 * passes this external driver a narrow typed Effect callback, so this file only
 * adapts Effect to the sandbox Promise contract.
 *
 * Per `gent/no-runpromise-outside-boundary`, that call lives here.
 * Each export NAMES a specific external seam — there is no generic
 * `runAnyEffect(services, effect)` trampoline.
 */

import { Effect, type Context } from "effect"
import type { CodemodeConfig } from "./mcp-codemode.js"

/**
 * Build the `runTool` adapter that the MCP Codemode JS sandbox calls.
 *
 * The Effect crossing the boundary is exactly one shape:
 *   `toolRunner.run({ toolCallId, toolName, input }, toolCtx)`
 * — pinned by this function. No other Effect leaves Effect-land here.
 */
export const makeAcpRunTool = (params: {
  readonly services: Context.Context<never>
  readonly runTool: (toolName: string, args: unknown) => Effect.Effect<unknown>
}): CodemodeConfig["runTool"] => {
  const runOnRuntime = Effect.runPromiseWith(params.services)

  return (toolName, args) => runOnRuntime(params.runTool(toolName, args))
}
