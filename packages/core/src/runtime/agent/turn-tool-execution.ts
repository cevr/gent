import { Cause, Effect, Exit, Option, Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { type AgentName as AgentNameType } from "../../domain/agent.js"
import {
  type BranchId,
  type MessageId,
  type SessionId,
  ToolCallId,
  ToolId,
} from "../../domain/ids.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import {
  CurrentExtensionHostContext,
  provideCurrentHostCtx,
} from "./current-extension-host-context.js"
import { ToolRunner, type ResolvedToolCapability } from "./tool-runner"
import { CurrentToolCall } from "./current-tool-call.js"
import { makeBindingReplayError, ToolBindingReplayError } from "./tool-binding-replay.js"
import { captureCurrentToolBinding, resolveReplayToolBinding } from "./tool-binding-resolution.js"
import { persistAssistantPartsWithBindings, persistToolParts } from "./turn-persistence.js"
import type { AgentLoopTurnProfile } from "./agent-loop.turn-profile.js"
import {
  processLocalReplayBindingKey,
  ProcessLocalToolReplay,
} from "./process-local-tool-replay.js"

const TOOL_CONCURRENCY = 8

/** InteractionPendingError enriched with the toolCallId that triggered it */
export class ToolInteractionPending extends Schema.TaggedError<ToolInteractionPending>(
  "@gent/core/src/runtime/agent/turn-tool-execution/ToolInteractionPending",
)("ToolInteractionPending", {
  pending: InteractionPendingError,
  toolCallId: ToolCallId,
  completedResults: Schema.Array(Prompt.ToolResultPart),
}) {}

export class ToolInvocationInteractionError extends Schema.TaggedError<ToolInvocationInteractionError>(
  "@gent/core/src/runtime/agent/turn-tool-execution/ToolInvocationInteractionError",
)("ToolInvocationInteractionError", {
  message: Schema.String,
  toolCallId: ToolCallId,
}) {}

export const executeToolCalls = Effect.fn("TurnHelpers.executeToolCalls")(function* (params: {
  assistantMessageId: MessageId
  toolCalls: ReadonlyArray<Prompt.ToolCallPart>
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  toolBindings: ReadonlyMap<string, ResolvedToolCapability>
  hostToolBindings: ReadonlyMap<string, ResolvedToolCapability>
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

export const invokeTool = Effect.fn("TurnHelpers.invokeTool")(function* (params: {
  assistantMessageId: MessageId
  toolResultMessageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  input: unknown
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  turnProfile: AgentLoopTurnProfile
}) {
  const messageStorage = yield* MessageStorage
  const processLocalReplay = yield* ProcessLocalToolReplay
  const storageTransaction = yield* makeStorageTransaction

  const localBindingKey = processLocalReplayBindingKey({
    sessionId: params.sessionId,
    branchId: params.branchId,
    assistantMessageId: params.assistantMessageId,
    toolCallId: params.toolCallId,
  })
  const currentGeneration = Option.fromUndefinedOr(params.turnProfile.turnPublication?.generationId)

  return yield* Effect.gen(function* () {
    const existingResult = yield* messageStorage.getMessage(params.toolResultMessageId)
    if (!Predicate.isUndefined(existingResult)) return
    const existingAssistant = yield* messageStorage.getMessage(params.assistantMessageId)
    let toolCall = Prompt.toolCallPart({
      id: params.toolCallId,
      name: params.toolName,
      params: params.input,
      providerExecuted: false,
    })
    if (!Predicate.isUndefined(existingAssistant)) {
      const storedToolCall = existingAssistant.parts.find(
        (part): part is Prompt.ToolCallPart =>
          part.type === "tool-call" && part.id === params.toolCallId,
      )
      if (Predicate.isUndefined(storedToolCall) || storedToolCall.name !== params.toolName) {
        return yield* makeBindingReplayError({
          assistantMessageId: params.assistantMessageId,
          toolCallId: params.toolCallId,
          toolId: ToolId.make(params.toolName),
          reason: "MissingBinding",
          message: `Stored assistant tool call ${params.toolCallId} does not match ${params.toolName}`,
        })
      }
      toolCall = storedToolCall
    }

    const toolBindings = new Map<string, ResolvedToolCapability>()
    let current = Option.none<ResolvedToolCapability>()
    if (Predicate.isNotUndefined(existingAssistant)) {
      const binding = yield* resolveReplayToolBinding({
        sessionId: params.sessionId,
        branchId: params.branchId,
        assistantMessageId: params.assistantMessageId,
        toolCall,
        publication: params.turnProfile.turnPublication,
      }).pipe(
        Effect.catchIf(Schema.is(ToolBindingReplayError), (error) =>
          Effect.gen(function* () {
            yield* persistToolParts({
              sessionId: params.sessionId,
              branchId: params.branchId,
              messageId: params.toolResultMessageId,
              parts: [
                Prompt.toolResultPart({
                  id: params.toolCallId,
                  name: toolCall.name,
                  isFailure: true,
                  providerExecuted: false,
                  result: { error: error.message, reason: error.reason },
                }),
              ],
            })
            return yield* error
          }),
        ),
      )
      toolBindings.set(toolCall.name, binding)
    } else {
      current = yield* captureCurrentToolBinding({
        sessionId: params.sessionId,
        toolName: toolCall.name,
        publication: params.turnProfile.turnPublication,
      })
      if (Option.isSome(current)) toolBindings.set(toolCall.name, current.value)
    }
    const toolCalls = [toolCall]

    const persisted = yield* persistAssistantPartsWithBindings({
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.assistantMessageId,
      parts: toolCalls,
      toolBindings,
      storageTransaction,
      agentName: params.currentTurnAgent,
    })
    if (Option.isSome(persisted) && persisted.value.inserted && Option.isSome(current)) {
      yield* processLocalReplay.setBinding(localBindingKey, {
        entry: current.value,
        generationId: currentGeneration,
      })
    }

    const toolResults = yield* executeToolCalls({
      hostToolBindings: toolBindings,
      assistantMessageId: params.assistantMessageId,
      toolCalls,
      sessionId: params.sessionId,
      branchId: params.branchId,
      currentTurnAgent: params.currentTurnAgent,
      toolBindings,
    })
    yield* persistToolParts({
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.toolResultMessageId,
      parts: toolResults,
    })
  }).pipe(
    Effect.onExit((exit) => {
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause)
        if (Option.isSome(error) && Schema.is(ToolInteractionPending)(error.value))
          return Effect.void
      }
      return Effect.gen(function* () {
        if (Exit.isFailure(exit)) {
          const assistant = yield* messageStorage.getMessage(params.assistantMessageId)
          if (Predicate.isNotUndefined(assistant)) {
            yield* persistToolParts({
              sessionId: params.sessionId,
              branchId: params.branchId,
              messageId: params.toolResultMessageId,
              parts: assistant.parts.flatMap((part) => {
                if (part.type !== "tool-call" || part.id !== params.toolCallId) return []
                return [
                  Prompt.toolResultPart({
                    id: part.id,
                    name: part.name,
                    isFailure: true,
                    providerExecuted: false,
                    result: { error: Cause.pretty(exit.cause) },
                  }),
                ]
              }),
            })
          }
        }
      }).pipe(Effect.ensuring(processLocalReplay.removeBinding(localBindingKey)))
    }),
  )
})
