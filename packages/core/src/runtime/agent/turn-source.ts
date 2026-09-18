import { Effect, Option, Predicate, Result, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  ErrorOccurred,
  EventPublisher,
  ModelContextProjected,
  ProviderRetrying,
} from "../../domain/event.js"
import { type BranchId, type MessageId, type SessionId, ToolCallId } from "../../domain/ids.js"
import type { InteractionPendingError } from "../../domain/interaction.js"
import { ExternalToolRunner, type ProviderAuthError, type TurnError } from "../../domain/driver.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import type { Message } from "../../domain/message.js"
import { calculateCost, type ModelId } from "../../domain/agent.js"
import { ModelRegistry } from "../model-registry.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { WideEvent, WideEventBoundary, withWideEvent } from "../wide-event-boundary.js"
import {
  type ActiveStreamHandle,
  type CollectedTurnResponse,
  collectFailedModelTurnResponse,
} from "./turn-response.js"
import { persistMessageParts, persistMessageReceived } from "./turn-persistence.js"
import { type ResolvedTurnContext } from "./turn-resolve.js"
import {
  convertTools,
  CurrentExtensionHostContext,
  CurrentToolCall,
  provideCurrentHostCtx,
  ToolRunner,
} from "./tools.js"
import { ToolCallBindingStorage } from "../../storage/tool-call-binding-storage.js"
import * as AiError from "effect/unstable/ai/AiError"
import type * as Response from "effect/unstable/ai/Response"
import { ProviderError, type StorageError } from "../../domain/errors.js"
import { toPrompt } from "../../providers/ai-transcript.js"
import { ModelResolver, type ResolveModelRequest } from "../../providers/model-resolver.js"
import { EventStorage } from "../../storage/event-storage.js"
import { SqlClient } from "effect/unstable/sql"
import { DriverRegistry } from "../extensions/driver-registry.js"
import {
  estimateTextTokens,
  estimateToolSchemaTokens,
  MODEL_OUTPUT_RESERVE_TOKENS,
  ModelContextBudget,
  ModelContextCapabilityError,
  ModelContextCapabilityFailure,
  ModelContextProjectionError,
  projectModelContext,
} from "../model-context.js"
import { ModelContextLedger } from "../model-context-ledger.js"
import { currentHandoffId, messagesInCurrentWindow } from "../model-context-window.js"
import { driverRetryPolicy, retryProviderCall } from "../retry.js"
import { causeMessage } from "../../domain/guards.js"
import { projectContextWindow } from "./turn-window.js"

/**
 * Where a turn's parts come from: the model stream or an external driver.
 *
 * `resolveTurnSource` projects the model context, applies the pending
 * context directive, and hands back a stream plus the collector that turns
 * it into a persisted response.
 */

export const toolCallsFromResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ReadonlyArray<Prompt.ToolCallPart> =>
  parts.flatMap((part): ReadonlyArray<Prompt.ToolCallPart> => {
    if (part.type === "tool-call") {
      return [
        Prompt.toolCallPart({
          id: part.id,
          name: part.name,
          params: part.params,
          providerExecuted: part.providerExecuted,
        }),
      ]
    }
    return []
  })

type ModelTurnSource = {
  readonly driverKind: "model"
  readonly driverId?: string
  readonly stream: Stream.Stream<Response.AnyPart, ProviderError>
  readonly formatStreamError: (streamError: ProviderError) => string
  readonly collect: <R>(
    effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
  ) => Effect.Effect<CollectedTurnResponse, ProviderAuthError, R | EventPublisher>
}

type ExternalTurnSource = {
  readonly driverKind: "external"
  readonly driverId?: string
  readonly stream: Stream.Stream<Response.AnyPart, TurnError | InteractionPendingError>
  readonly formatStreamError: (streamError: TurnError) => string
  readonly collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export type ExternalToolPersistence = {
  readonly assistantMessageId: MessageId
  readonly toolResultMessageId: MessageId
}

export const resolveTurnSource = Effect.fn("TurnHelpers.resolveTurnSource")(function* (params: {
  messageId: MessageId
  step: number
  /**
   * The last step this turn may run. The model keeps its tool definitions —
   * dropping them would invalidate the provider's cached prefix — but is told
   * it may not call one, so the step produces the turn's answer.
   */
  finalStep: boolean
  resolved: ResolvedTurnContext
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  randomId: Effect.Effect<string>
  persistExternalToolCall: (
    toolCall: Prompt.ToolCallPart,
  ) => Effect.Effect<
    ExternalToolPersistence,
    StorageError | TurnError,
    EventPublisher | EventStorage | MessageStorage | ToolCallBindingStorage
  >
}) {
  const driverRegistry = yield* DriverRegistry
  const hostCtx = yield* CurrentExtensionHostContext
  const publishEventOrDie = (event: ErrorOccurred | ProviderRetrying) =>
    Effect.gen(function* () {
      const eventPublisher = yield* EventPublisher
      yield* eventPublisher.publish(event).pipe(Effect.orDie)
    })
  const { resolved } = params
  const operations = yield* SessionOperationStorage
  const reserveAttempt = operations
    .reserveChildModelAttempt({ sessionId: params.sessionId, branchId: params.branchId })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProviderError({
            message: "Cannot reserve child model attempt",
            model: resolved.modelId,
            cause,
          }),
      ),
    )
  const resolvedDriver = resolved.driver
  if (Predicate.isNotUndefined(resolvedDriver) && resolvedDriver._tag === "External") {
    if (Option.isSome(yield* reserveAttempt)) {
      return yield* new ProviderError({
        message: "Admitted child model budgets do not support external drivers",
        model: resolved.modelId,
      })
    }
    const externalDriver = yield* driverRegistry.getExternal(resolvedDriver.id)
    const executor = Option.fromUndefinedOr(externalDriver).pipe(
      Option.flatMap((value) => Option.fromUndefinedOr(value.executor)),
    )
    if (Option.isNone(executor)) {
      yield* publishEventOrDie(
        ErrorOccurred.make({
          sessionId: params.sessionId,
          branchId: params.branchId,
          error: `External driver "${resolvedDriver.id}" not found`,
        }),
      )
      // oxlint-disable-next-line effect/noNullish -- A missing external executor is an expected resolution miss after the error event is published.
      return undefined
    }

    // The executor calls back from its own context, so the tool run and its
    // persistence carry the services they need from here.
    const toolRunner = yield* ToolRunner
    const extensionRegistry = yield* ExtensionRegistry
    const eventPublisher = yield* EventPublisher
    const eventStorage = yield* EventStorage
    const messageStorage = yield* MessageStorage
    const toolBindingStorage = yield* ToolCallBindingStorage
    const sql = yield* SqlClient.SqlClient
    const externalToolRunner = ExternalToolRunner.of({
      runTool: (toolName, args) =>
        Effect.gen(function* () {
          const toolCallId = ToolCallId.make(yield* params.randomId)
          const persistence = yield* params
            .persistExternalToolCall(
              Prompt.toolCallPart({
                id: toolCallId,
                name: toolName,
                params: args,
                providerExecuted: false,
              }),
            )
            .pipe(Effect.catchTag("StorageError", Effect.die))
          const result = yield* toolRunner
            .runBound(
              { toolCallId, toolName, input: args },
              Option.fromUndefinedOr(resolved.toolBindings.get(toolName)),
            )
            .pipe(
              provideCurrentHostCtx(hostCtx),
              Effect.provideService(ExtensionRegistry, extensionRegistry),
              Effect.provideService(EventPublisher, eventPublisher),
              Effect.provideService(CurrentToolCall, {
                toolBindings: resolved.toolBindings,
                sessionId: params.sessionId,
                branchId: params.branchId,
                assistantMessageId: persistence.assistantMessageId,
                toolCallId,
              }),
            )
          yield* persistMessageParts({
            role: "tool",
            sessionId: params.sessionId,
            branchId: params.branchId,
            messageId: persistence.toolResultMessageId,
            parts: [result],
          }).pipe(Effect.orDie)
          return result
        }).pipe(
          Effect.provideService(MessageStorage, messageStorage),
          Effect.provideService(ToolCallBindingStorage, toolBindingStorage),
          Effect.provideService(EventPublisher, eventPublisher),
          Effect.provideService(EventStorage, eventStorage),
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
    })

    return {
      driverKind: "external",
      driverId: resolvedDriver.id,
      stream: executor.value
        .executeTurn({
          sessionId: params.sessionId,
          branchId: params.branchId,
          agent: resolved.agent,
          messages: resolved.messages,
          tools: resolved.tools,
          systemPrompt: resolved.systemPrompt,
          cwd: hostCtx.cwd,
          abortSignal: params.activeStream.abortSignal,
          hostCtx,
        })
        .pipe(Stream.provideService(ExternalToolRunner, externalToolRunner)),
      // oxlint-disable-next-line effect/noUnknownParameters -- External driver errors cross an untyped executor boundary.
      formatStreamError: (streamError: unknown) =>
        `External turn executor error: ${causeMessage(streamError)}`,
      collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    } satisfies ExternalTurnSource
  }

  const modelResolver = yield* ModelResolver
  const resolveAdmittedModel = Effect.fn("TurnHelpers.resolveAdmittedModel")(function* (
    request: ResolveModelRequest,
  ) {
    const admission = yield* reserveAttempt
    if (Option.isSome(admission) && !admission.value) {
      return yield* new ProviderError({
        message: "Child model-attempt budget exhausted",
        model: resolved.modelId,
      })
    }
    return yield* modelResolver.resolve(request)
  })
  const { driverId, contextModelId } = resolved.modelDriver
  const modelRequest: ResolveModelRequest = {
    modelId: resolved.modelId,
    hints: {
      temperature: resolved.temperature,
      reasoning: resolved.reasoning,
      cacheKey: params.sessionId,
    },
    driverRegistry,
    driverId: Option.getOrUndefined(driverId),
  }

  const retryPolicy = yield* driverRetryPolicy(driverRegistry, driverId)

  const modelRegistry = yield* ModelRegistry
  const modelOption = yield* modelRegistry.get(contextModelId)
  if (Option.isNone(modelOption)) {
    return yield* new ModelContextCapabilityError({
      failure: ModelContextCapabilityFailure.cases.UnknownModel.make({
        modelId: contextModelId,
      }),
    })
  }
  // The agent's own window wins over the catalog: config or a run override can shrink it.
  const contextLimit = Option.getOrUndefined(
    Option.orElse(Option.fromUndefinedOr(resolved.agent.contextLength), () =>
      Option.fromUndefinedOr(modelOption.value.contextLength),
    ),
  )
  if (Predicate.isUndefined(contextLimit)) {
    return yield* new ModelContextCapabilityError({
      failure: ModelContextCapabilityFailure.cases.MissingContextLimit.make({
        modelId: contextModelId,
      }),
    })
  }
  if (!Number.isSafeInteger(contextLimit) || contextLimit <= 0) {
    return yield* new ModelContextCapabilityError({
      failure: ModelContextCapabilityFailure.cases.InvalidContextLimit.make({
        modelId: contextModelId,
        reason: "contextLength must be a positive safe integer",
      }),
    })
  }
  const budget = ModelContextBudget.make({
    contextLimitTokens: contextLimit,
    reservedSystemTokens: estimateTextTokens(resolved.systemPrompt),
    reservedToolTokens: estimateToolSchemaTokens(resolved.tools),
    reservedOutputTokens: MODEL_OUTPUT_RESERVE_TOKENS,
  })
  const eventPublisher = yield* EventPublisher
  // Summaries and window markers persist the same way every durable message
  // does: once, with a delivered event.
  const persistDurableMessage = (message: Message) => persistMessageReceived({ message })
  // The model can ask, from inside a dispatching tool, for a fresh window or a
  // focused summary. A branch with no such tool has no ledger and no
  // directives, so the read falls back to an inert one.
  const ledger = Option.getOrElse(
    yield* Effect.serviceOption(ModelContextLedger),
    () => ModelContextLedger.inert,
  )
  // A directive belongs to the turn whose tool call scheduled it: the first
  // projection of a new turn drops whatever an earlier turn left behind.
  if (params.step <= 1) yield* ledger.discardDirective
  const directive = yield* ledger.pendingDirective
  const project = (messages: ReadonlyArray<Message>) =>
    Effect.gen(function* () {
      const projection = projectModelContext(messages, budget)
      if (Result.isFailure(projection)) {
        return yield* new ModelContextProjectionError({
          modelId: contextModelId,
          failure: projection.failure,
        })
      }
      return projection.success
    })
  const { durableMessages, compacted } = yield* projectContextWindow({
    sessionId: params.sessionId,
    branchId: params.branchId,
    modelId: contextModelId,
    messages: resolved.messages,
    budget,
    directive,
    project,
    persist: persistDurableMessage,
    summaryModel: (maxTokens) =>
      resolveAdmittedModel({
        ...modelRequest,
        hints: { ...modelRequest.hints, maxTokens },
      }),
  })

  const finalWindow = messagesInCurrentWindow(durableMessages)
  const projection = yield* project(finalWindow)
  const handoffMessageId = Option.getOrUndefined(currentHandoffId(finalWindow))
  yield* ledger.recordProjection({
    estimatedTokens: projection.estimatedTokens,
    availableInputTokens: projection.availableInputTokens,
    contextLimitTokens: contextLimit,
    omittedMessages: projection.omittedMessageIds.length,
    handoffMessageId,
  })
  // Acknowledged only after the projection it shaped succeeded, so a failed
  // projection retries it and a successful one applies it exactly once.
  if (Option.isSome(directive)) yield* ledger.acknowledgeDirective(directive.value)
  yield* eventPublisher.publish(
    ModelContextProjected.make({
      sessionId: params.sessionId,
      branchId: params.branchId,
      estimatedTokens: projection.estimatedTokens,
      availableInputTokens: projection.availableInputTokens,
      contextLimitTokens: contextLimit,
      omittedMessages: projection.omittedMessageIds.length,
      handoffMessageId,
      compacted,
    }),
  )
  const prompt = toPrompt(projection.messages, { systemPrompt: resolved.systemPrompt })
  const toolkit = convertTools([...resolved.tools])
  const rawStream = Stream.unwrap(
    resolveAdmittedModel(modelRequest).pipe(
      Effect.map((model) => {
        if (resolved.tools.length > 0) {
          if (params.finalStep) {
            return model.streamText({
              prompt,
              toolkit,
              toolChoice: "none",
              disableToolCallResolution: true,
            })
          }
          return model.streamText({
            prompt,
            toolkit,
            disableToolCallResolution: true,
          })
        }
        return model.streamText({ prompt })
      }),
    ),
  )

  return {
    driverKind: "model",
    stream: rawStream.pipe(
      Stream.mapError(
        // oxlint-disable-next-line effect/noUnknownParameters -- Model streams expose provider-specific error values.
        (error: unknown) => {
          let message = String(error)
          if (AiError.isAiError(error)) message = error.message
          return new ProviderError({
            message,
            model: resolved.modelId,
            cause: error,
          })
        },
      ),
    ),
    formatStreamError: causeMessage,
    collect: <R>(
      effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
    ) =>
      // `ProviderAuthError` is a fail-closed credential-absence signal —
      // not retryable, not recoverable mid-turn. Let it escape so the RPC
      // seam surfaces the typed auth failure; narrow the retry scope to
      // transient `ProviderError` only.
      effect.pipe(
        retryProviderCall(retryPolicy, {
          onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
            publishEventOrDie(
              ProviderRetrying.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                attempt,
                maxAttempts,
                delayMs,
                error: error.message,
              }),
            ),
        }),
        Effect.catchTag("ProviderError", (streamError) =>
          collectFailedModelTurnResponse({
            messageId: params.messageId,
            step: params.step,
            streamError,
            sessionId: params.sessionId,
            branchId: params.branchId,
            activeStream: params.activeStream,
            formatStreamError: causeMessage,
          }),
        ),
        Effect.tap((collected) => {
          const usage = Option.getOrElse(
            Option.fromUndefinedOr(collected.messageProjection.usage),
            () => ({ inputTokens: 0, outputTokens: 0 }),
          )
          return WideEvent.set({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
            interrupted: collected.interrupted,
            streamFailed: collected.streamFailed,
          })
        }),
        withWideEvent(
          WideEventBoundary.provider("stream", {
            envelope: { model: resolved.modelId },
          }),
        ),
      ),
  } satisfies ModelTurnSource
})

// Freeze pricing into the StreamEnded event at emit time. Returns None
// when usage is absent or pricing is missing; the reducer treats that as a
// zero contribution. Storing the computed cost on the event makes the
// transcript authoritative: replaying the same events always sums to the
// same cost, even if ModelRegistry pricing later refreshes.
export const computeStreamEndedCost: (params: {
  modelId: ModelId
  usage: Option.Option<{ inputTokens: number; outputTokens: number }>
}) => Effect.Effect<Option.Option<number>, never, ModelRegistry> = Effect.fn(
  "TurnHelpers.computeStreamEndedCost",
)(function* (params) {
  if (Option.isNone(params.usage)) return Option.none()
  const modelRegistry = yield* ModelRegistry
  const pricing = yield* modelRegistry.list.pipe(
    Effect.map((models) =>
      Option.fromUndefinedOr(models.find((m) => m.id === params.modelId)?.pricing),
    ),
    Effect.catchEager(() => Effect.succeedNone),
  )
  if (Option.isNone(pricing)) return Option.none()
  return Option.some(calculateCost(params.usage.value, pricing))
})
