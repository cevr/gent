import { Cause, Effect, Exit, Option, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { type AgentName as AgentNameType } from "../../domain/agent.js"
import { type BranchId, type MessageId, type SessionId, ToolCallId } from "../../domain/ids.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import {
  CurrentExtensionHostContext,
  provideCurrentHostCtx,
} from "./current-extension-host-context.js"
import { ToolRunner, type ResolvedToolCapability } from "./tool-runner"
import { CurrentToolCall } from "./current-tool-call.js"
import { TurnInterruptSignal } from "./turn-interruption.js"

const TOOL_CONCURRENCY = 8

/** InteractionPendingError enriched with the toolCallId that triggered it */
export class ToolInteractionPending extends Schema.TaggedError<ToolInteractionPending>(
  "@gent/core/src/runtime/agent/turn-tool-execution/ToolInteractionPending",
)("ToolInteractionPending", {
  pending: InteractionPendingError,
  toolCallId: ToolCallId,
  completedResults: Schema.Array(Prompt.ToolResultPart),
}) {}

export const executeToolCalls = Effect.fn("TurnHelpers.executeToolCalls")(function* (params: {
  assistantMessageId: MessageId
  toolCalls: ReadonlyArray<Prompt.ToolCallPart>
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  hostToolBindings: ReadonlyMap<string, ResolvedToolCapability>
  /** Completes when the turn is interrupted; a call still running then stops. */
  interruption: Effect.Effect<void>
}) {
  const toolRunner = yield* ToolRunner
  const hostCtx = yield* CurrentExtensionHostContext
  const exits = yield* Effect.forEach(
    params.toolCalls,
    (toolCall) =>
      Effect.exit(
        Effect.gen(function* () {
          const toolHostCtx = {
            ...hostCtx,
            agentName: params.currentTurnAgent,
            toolCallId: ToolCallId.make(toolCall.id),
          }
          const toolCallInput = {
            toolCallId: ToolCallId.make(toolCall.id),
            toolName: toolCall.name,
            input: toolCall.params,
          }
          return yield* toolRunner
            .runBound(toolCallInput, Option.fromUndefinedOr(params.toolBindings.get(toolCall.name)))
            .pipe(
              Effect.mapError(
                (e) =>
                  new ToolInteractionPending({
                    pending: e,
                    toolCallId: ToolCallId.make(toolCall.id),
                    completedResults: [],
                  }),
              ),
              provideCurrentHostCtx(toolHostCtx),
              Effect.provideService(CurrentToolCall, {
                toolBindings: params.hostToolBindings,
                sessionId: params.sessionId,
                branchId: params.branchId,
                assistantMessageId: params.assistantMessageId,
                toolCallId: toolCallInput.toolCallId,
              }),
              Effect.provideService(TurnInterruptSignal, params.interruption),
            )
        }),
      ),
    { concurrency: Math.max(1, TOOL_CONCURRENCY) },
  )
  const results: Array<Prompt.ToolResultPart> = []
  let pending = Option.none<ToolInteractionPending>()
  for (const exit of exits) {
    if (Exit.isSuccess(exit)) {
      results.push(exit.value)
      continue
    }
    const error = Cause.findErrorOption(exit.cause)
    if (Option.isSome(error)) {
      if (Option.isNone(pending)) pending = error
      continue
    }
    return yield* Effect.failCause(exit.cause)
  }
  if (Option.isSome(pending)) {
    return yield* new ToolInteractionPending({
      pending: pending.value.pending,
      toolCallId: pending.value.toolCallId,
      completedResults: results,
    })
  }
  return results
})
