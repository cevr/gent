import { Effect, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { type AgentName as AgentNameType } from "../../domain/agent.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { type BranchId, type MessageId, type SessionId, ToolCallId } from "../../domain/ids.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { ToolRunner } from "./tool-runner"
import { persistAssistantParts, persistToolParts } from "./turn-persistence.js"
import type { PublishEvent } from "./turn-response.js"

const TOOL_CONCURRENCY = 8

/** InteractionPendingError enriched with the toolCallId that triggered it */
export class ToolInteractionPending extends Schema.TaggedErrorClass<ToolInteractionPending>(
  "@gent/core-internal/runtime/agent/turn-tool-execution/ToolInteractionPending",
)("ToolInteractionPending", {
  pending: InteractionPendingError,
  toolCallId: ToolCallId,
}) {}

export const executeToolCalls = Effect.fn("TurnHelpers.executeToolCalls")(function* (params: {
  toolCalls: ReadonlyArray<Prompt.ToolCallPart>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  hostCtx: ExtensionHostContext
}) {
  const toolRunner = yield* ToolRunner
  return yield* Effect.forEach(
    params.toolCalls,
    (toolCall) =>
      Effect.gen(function* () {
        const ctx = {
          ...params.hostCtx,
          agentName: params.currentTurnAgent,
          toolCallId: ToolCallId.make(toolCall.id),
        }
        return yield* toolRunner
          .run(
            {
              toolCallId: ToolCallId.make(toolCall.id),
              toolName: toolCall.name,
              input: toolCall.params,
            },
            ctx,
            { publishEvent: params.publishEvent },
          )
          .pipe(
            Effect.mapError(
              (e) =>
                new ToolInteractionPending({
                  pending: e,
                  toolCallId: ToolCallId.make(toolCall.id),
                }),
            ),
          )
      }),
    { concurrency: Math.max(1, TOOL_CONCURRENCY) },
  )
})

export const invokeTool = Effect.fn("TurnHelpers.invokeTool")(function* (params: {
  assistantMessageId: MessageId
  toolResultMessageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  input: unknown
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  hostCtx: ExtensionHostContext
}) {
  const messageStorage = yield* MessageStorage
  const toolCalls = [
    Prompt.toolCallPart({
      id: params.toolCallId,
      name: params.toolName,
      params: params.input,
      providerExecuted: false,
    }),
  ] as const

  yield* persistAssistantParts({
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.assistantMessageId,
    parts: toolCalls,
    agentName: params.currentTurnAgent,
  })

  const existing = yield* messageStorage.getMessage(params.toolResultMessageId)
  if (existing !== undefined) return

  const toolResults = yield* executeToolCalls({
    toolCalls,
    publishEvent: params.publishEvent,
    sessionId: params.sessionId,
    branchId: params.branchId,
    currentTurnAgent: params.currentTurnAgent,
    hostCtx: params.hostCtx,
  })
  yield* persistToolParts({
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.toolResultMessageId,
    parts: toolResults,
  })
})
