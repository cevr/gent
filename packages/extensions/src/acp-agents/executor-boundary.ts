/**
 * Boundary helper for {@link createAcpTurnExecutor}.
 *
 * The MCP Codemode `runTool` callback hands the `execute` code to the branch
 * cell; the MCP SDK is a Promise-returning host. Core owns actual tool
 * execution and passes this external driver a narrow typed Effect callback, so
 * this file only adapts Effect to the MCP Promise contract.
 *
 * Per `gent/no-runpromise-outside-boundary`, that call lives here.
 * Each export NAMES a specific external seam — there is no generic
 * `runAnyEffect(services, effect)` trampoline.
 */

import { Effect, type Context } from "effect"
import type { InteractionPendingError, TurnError } from "@gent/core/extensions/api"
import type { CodemodeConfig } from "./mcp-codemode.js"

/**
 * Build the `runTool` adapter that the MCP Codemode server calls.
 *
 * The Effect crossing the boundary is exactly one shape:
 *   `toolRunner.runTool(toolName, args)`
 * — pinned by this function. It runs with the turn's captured services so the
 * `cell` tool finds the branch cell owner and turn profile.
 */
export const makeAcpRunTool =
  (params: {
    readonly services: Context.Context<never>
    readonly runTool: (
      toolName: string,
      args: Parameters<CodemodeConfig["runTool"]>[1],
    ) => Effect.Effect<unknown, InteractionPendingError | TurnError>
  }): CodemodeConfig["runTool"] =>
  (toolName, args) =>
    Effect.runPromiseWith(params.services)(params.runTool(toolName, args))

export const makeAcpInteractionPendingNotifier =
  (params: {
    readonly services: Context.Context<never>
    readonly notify: (pending: InteractionPendingError) => Effect.Effect<void>
  }): CodemodeConfig["onInteractionPending"] =>
  (pending) =>
    Effect.runPromiseWith(params.services)(params.notify(pending))
