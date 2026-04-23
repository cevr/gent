/**
 * Boundary helper for {@link createAcpTurnExecutor}.
 *
 * The MCP Codemode `runTool` callback hands tool invocations to a
 * JS sandbox; that sandbox is a Promise-returning host (sandbox API
 * deliberately stays on the platform side, not the Effect side). To
 * cross from `ToolRunner.run` (typed Effect) into the sandbox's
 * Promise contract, we exit Effect-land via `Effect.runPromiseWith`.
 *
 * Per `gent/no-runpromise-outside-boundary`, that call lives here.
 * Each export NAMES a specific external seam — there is no generic
 * `runAnyEffect(services, effect)` trampoline.
 */

import { Context, Effect } from "effect"
import { ToolCallId, makeToolContext, type ToolContext } from "@gent/core/extensions/api"
import { ToolRunner } from "../core-internal.js"
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
  readonly hostCtx: Omit<ToolContext, "toolCallId">
}): CodemodeConfig["runTool"] => {
  // The TurnExecutor interface erases the executor's context channel, but
  // the agent runtime ambiently provides ToolRunner at invocation time. Re-
  // type the captured ServiceMap to expose the typed ToolRunner key.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const ambient = params.services as unknown as Context.Context<ToolRunner>
  const toolRunner = Context.get(ambient, ToolRunner)
  const runOnRuntime = Effect.runPromiseWith(params.services)

  return (toolName, args) => {
    const toolCallId = ToolCallId.make(crypto.randomUUID())
    const toolCtx: ToolContext = makeToolContext(params.hostCtx, toolCallId)
    return runOnRuntime(toolRunner.run({ toolCallId, toolName, input: args }, toolCtx))
  }
}
