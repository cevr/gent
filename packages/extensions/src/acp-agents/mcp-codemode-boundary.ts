/** Named adapters for Promise contracts owned by MCP and the codemode host. */

import { Effect, Option, Predicate, Schema } from "effect"
import { InteractionPendingError } from "@gent/core/extensions/api"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { CodemodeConfig } from "./mcp-codemode.js"

class CodemodeInvocationError extends Schema.TaggedError<CodemodeInvocationError>(
  "@gent/extensions/src/acp-agents/mcp-codemode-boundary/CodemodeInvocationError",
)("CodemodeInvocationError", {
  cause: Schema.Unknown,
}) {}

// The runTool host may throw any value. Normalize it before it enters the
// typed Effect error channel.
// oxlint-disable-next-line effect/noUnknownParameters -- host throw boundary
const normalizeThrownError = (
  // oxlint-disable-next-line effect/noUnknownParameters -- host throw boundary
  error: unknown,
): InteractionPendingError | CodemodeInvocationError => {
  if (Schema.is(InteractionPendingError)(error)) return error
  return new CodemodeInvocationError({ cause: error })
}

const normalizeCodemodeResult = (
  result: ReturnType<CodemodeConfig["runTool"]>,
): Effect.Effect<unknown, CodemodeInvocationError | InteractionPendingError> => {
  if (Predicate.isPromiseLike(result)) {
    return Effect.tryPromise({
      try: () => result,
      catch: normalizeThrownError,
    })
  }
  return Effect.succeed(result)
}

/**
 * Forward one `execute` request to the branch's `cell` tool. The MCP SDK owns
 * the Promise contract, so this is the single `runPromise` for that seam.
 */
export const invokeCodemodeCell = (
  code: string,
  runTool: CodemodeConfig["runTool"],
  onInteractionPending: CodemodeConfig["onInteractionPending"],
) =>
  Effect.runPromise(
    Effect.try({
      try: () => runTool("cell", { code }),
      catch: normalizeThrownError,
    }).pipe(
      Effect.flatMap(normalizeCodemodeResult),
      Effect.tapError((error) => {
        if (!Schema.is(InteractionPendingError)(error)) return Effect.void
        const pendingNotifier = Option.fromNullishOr(onInteractionPending)
        if (Option.isNone(pendingNotifier)) return Effect.void
        return Effect.sync(() => {
          void pendingNotifier.value(error)
        })
      }),
    ),
  )

/** Build the MCP SDK transport with no session identifier. */
export const makeStatelessMcpTransport = (): WebStandardStreamableHTTPServerTransport =>
  new WebStandardStreamableHTTPServerTransport()

/** Serialize an arbitrary codemode result for the MCP text wire shape. */
export const inspectMcpResult = (value: Parameters<typeof JSON.stringify>[0]): string => {
  const seen = new WeakSet<object>()
  const jsonString = Schema.fromJsonString(Schema.Unknown, {
    replacer: (_key, part) => {
      if (Schema.is(Schema.BigInt)(part)) return `${part.toString()}n`
      if (Schema.is(Schema.ObjectKeyword)(part)) {
        if (seen.has(part)) return "[Circular]"
        seen.add(part)
      }
      return part
    },
    space: 2,
  })
  return Effect.runSync(
    Schema.encodeEffect(jsonString)(value).pipe(Effect.orElseSucceed(() => String(value))),
  )
}
