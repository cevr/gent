import { DateTime, Effect, Option, Predicate, Result, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiError from "effect/unstable/ai/AiError"
import type * as Response from "effect/unstable/ai/Response"
import { ExternalToolRunner, type ProviderAuthError, type TurnError } from "../../domain/driver.js"
import {
  ErrorOccurred,
  MessageReceived,
  ModelContextProjected,
  ProviderRetrying,
  type EventEnvelope,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { ToolCallId, type BranchId, type MessageId, type SessionId } from "../../domain/ids.js"
import { CurrentToolCall } from "./current-tool-call.js"
import type { InteractionPendingError } from "../../domain/interaction-request.js"
import { type Message } from "../../domain/message.js"
import { ModelId, parseModelId } from "../../domain/model.js"
import { ProviderError } from "../../domain/provider-error.js"
import { StorageError } from "../../domain/storage-error.js"
import { toPrompt } from "../../providers/ai-transcript.js"
import { ModelResolver } from "../../providers/model-resolver.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import { DriverRegistry } from "../extensions/driver-registry.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import {
  estimateSystemPromptTokens,
  estimateToolSchemaTokens,
  MODEL_OUTPUT_RESERVE_TOKENS,
  ModelContextBudget,
  ModelContextCapabilityError,
  ModelContextCapabilityFailure,
  ModelContextProjectionError,
  projectModelContext,
} from "../model-context.js"
import {
  compactModelContext,
  latestCompactionRevision,
  MODEL_COMPACTION_OUTPUT_TOKENS,
  type ModelCompactionError,
  ModelCompactionResult,
} from "../model-compaction.js"
import { CellNamespaceStorage } from "../../storage/cell-namespace-storage.js"
import { type ContextDirective, ModelContextLedger } from "../model-context-ledger.js"
import {
  latestUserMessageId,
  messagesInCurrentWindow,
  windowMarkerMessage,
} from "../model-context-window.js"
import { ModelRegistry } from "../model-registry.js"
import { DEFAULT_RETRY_CONFIG, retryProviderCall } from "../retry"
import { WideEvent, WideEventBoundary, withWideEvent } from "../wide-event-boundary"
import {
  CurrentExtensionHostContext,
  provideCurrentHostCtx,
} from "./current-extension-host-context.js"
import { convertTools, ToolRunner } from "./tool-runner"
import {
  collectFailedModelTurnResponse,
  formatStreamErrorMessage,
  type ActiveStreamHandle,
  type CollectedTurnResponse,
} from "./turn-response.js"
import type { ResolvedTurnContext } from "./turn-resolve.js"
import type { ResolveModelRequest } from "../../providers/model-resolver.js"

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

interface CompactionRequest {
  readonly instructions?: string
}

/** A new window persists its marker; a compaction request only shapes this projection. */
const applyContextDirective = Effect.fn("TurnHelpers.applyContextDirective")(function* <
  E,
  R,
>(params: {
  readonly directive: Option.Option<ContextDirective>
  readonly messages: ReadonlyArray<Message>
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly persist: (message: Message) => Effect.Effect<Message, E, R>
}) {
  if (Option.isNone(params.directive)) {
    return { durableMessages: params.messages, force: Option.none<CompactionRequest>() }
  }
  if (params.directive.value._tag === "Compact") {
    return {
      durableMessages: params.messages,
      force: Option.some<CompactionRequest>({
        instructions: params.directive.value.instructions,
      }),
    }
  }
  const anchor = latestUserMessageId(params.messages)
  if (Option.isNone(anchor)) {
    return { durableMessages: params.messages, force: Option.none<CompactionRequest>() }
  }
  const marker = yield* params.persist(
    windowMarkerMessage({
      sessionId: params.sessionId,
      branchId: params.branchId,
      keepFromMessageId: anchor.value,
      createdAt: yield* DateTime.nowAsDate,
    }),
  )
  return { durableMessages: [...params.messages, marker], force: Option.none<CompactionRequest>() }
})

export const resolveTurnSource = Effect.fn("TurnHelpers.resolveTurnSource")(function* (params: {
  messageId: MessageId
  step: number
  resolved: ResolvedTurnContext
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  randomId: Effect.Effect<string>
  hash: (input: string) => string
  persistExternalToolCall: (
    toolCall: Prompt.ToolCallPart,
  ) => Effect.Effect<ExternalToolPersistence, StorageError | TurnError>
  persistExternalToolResult: (
    persistence: ExternalToolPersistence,
    result: Prompt.ToolResultPart,
  ) => Effect.Effect<void, StorageError>
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
  if (Predicate.isNotUndefined(resolvedDriver) && resolvedDriver._tag === "external") {
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

    const toolRunner = yield* ToolRunner
    const extensionRegistry = yield* ExtensionRegistry
    const eventPublisher = yield* EventPublisher
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
          yield* params.persistExternalToolResult(persistence, result).pipe(Effect.orDie)
          return result
        }),
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
        `External turn executor error: ${formatStreamErrorMessage(streamError)}`,
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
  let modelRequest: ResolveModelRequest = {
    modelId: resolved.modelId,
    hints: {
      temperature: resolved.temperature,
      reasoning: resolved.reasoning,
    },
    driverRegistry,
  }
  if (
    Predicate.isNotUndefined(resolvedDriver) &&
    resolvedDriver._tag === "model" &&
    Predicate.isNotUndefined(resolvedDriver.id)
  ) {
    modelRequest = { ...modelRequest, driverId: resolvedDriver.id }
  }

  const modelRegistry = yield* ModelRegistry
  let contextModelId = resolved.modelId
  if (
    Predicate.isNotUndefined(resolvedDriver) &&
    resolvedDriver._tag === "model" &&
    Predicate.isNotUndefined(resolvedDriver.id)
  ) {
    const parsedModelId = parseModelId(resolved.modelId)
    if (Option.isSome(parsedModelId)) {
      contextModelId = ModelId.make(`${resolvedDriver.id}/${parsedModelId.value[1]}`)
    }
  }
  const modelOption = yield* modelRegistry.get(contextModelId)
  if (Option.isNone(modelOption)) {
    return yield* new ModelContextCapabilityError({
      failure: ModelContextCapabilityFailure.cases.UnknownModel.make({
        modelId: contextModelId,
      }),
    })
  }
  const contextLimit = modelOption.value.contextLength
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
    reservedSystemTokens: estimateSystemPromptTokens(resolved.systemPrompt),
    reservedToolTokens: estimateToolSchemaTokens(resolved.tools),
    reservedOutputTokens: MODEL_OUTPUT_RESERVE_TOKENS,
  })
  const eventPublisher = yield* EventPublisher
  const messageStorage = yield* MessageStorage
  const storageTransaction = yield* makeStorageTransaction
  // Summaries and window markers persist the same way: once, with a delivered event.
  const persistDurableMessage = (message: Message) =>
    Effect.gen(function* () {
      const persisted = yield* storageTransaction(
        Effect.gen(function* () {
          const existing = yield* messageStorage.getMessage(message.id)
          if (Predicate.isNotUndefined(existing)) {
            return { message: existing, envelope: Option.none<EventEnvelope>() }
          }
          yield* messageStorage.createMessageIfAbsent(message)
          const stored = yield* messageStorage.getMessage(message.id)
          if (Predicate.isUndefined(stored)) {
            return yield* new StorageError({ message: "Summary was not readable after insertion" })
          }
          return {
            message: stored,
            envelope: Option.some(
              yield* eventPublisher.append(MessageReceived.make({ message: stored })),
            ),
          }
        }),
      )
      if (Option.isSome(persisted.envelope)) yield* eventPublisher.deliver(persisted.envelope.value)
      return persisted.message
    })
  // The model can ask, from a cell, for a fresh window or a focused summary.
  const ledger = yield* ModelContextLedger
  const { durableMessages, force } = yield* applyContextDirective({
    directive: yield* ledger.takeDirective,
    messages: resolved.messages,
    sessionId: params.sessionId,
    branchId: params.branchId,
    persist: persistDurableMessage,
  })
  const windowed = messagesInCurrentWindow(durableMessages)
  // The summary names the cell bindings that survive compaction.
  const namespaces = yield* CellNamespaceStorage
  const cellBindings = Option.match(
    yield* namespaces.get({ sessionId: params.sessionId, branchId: params.branchId }),
    { onNone: () => [], onSome: (snapshot) => snapshot.bindings.map((binding) => binding.name) },
  )
  const compact = (forced: Option.Option<CompactionRequest>) =>
    compactModelContext({
      modelId: contextModelId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messages: windowed,
      budget,
      hash: params.hash,
      persistSummary: persistDurableMessage,
      cellBindings,
      force: Option.getOrUndefined(forced),
      summaryModel: resolveAdmittedModel({
        ...modelRequest,
        hints: { ...modelRequest.hints, maxTokens: MODEL_COMPACTION_OUTPUT_TOKENS },
      }),
    })
  // A summary that cannot be produced must not cost the turn: a requested one
  // falls back to the automatic path, and that falls back to the plain
  // truncated projection with a visible notice.
  const degraded = (error: ModelCompactionError) =>
    Effect.gen(function* () {
      const projection = projectModelContext(windowed, budget)
      if (Result.isFailure(projection)) {
        return yield* new ModelContextProjectionError({
          modelId: contextModelId,
          failure: projection.failure,
        })
      }
      yield* eventPublisher.publish(
        ErrorOccurred.make({
          sessionId: params.sessionId,
          branchId: params.branchId,
          error: `Context compaction failed (${error.failure._tag}); continuing with ${projection.success.omittedMessageIds.length} older messages omitted`,
        }),
      )
      return ModelCompactionResult.make({
        messages: [...windowed],
        projection: projection.success,
        compacted: false,
      })
    })
  const compacted = yield* compact(force).pipe(
    Effect.catchTag("ModelCompactionError", (error) => {
      if (Option.isNone(force)) return degraded(error)
      return Effect.logWarning("Requested compaction failed; continuing without it")
        .pipe(Effect.annotateLogs({ error: String(error) }))
        .pipe(
          Effect.andThen(
            compact(Option.none()).pipe(Effect.catchTag("ModelCompactionError", degraded)),
          ),
        )
    }),
  )
  yield* ledger.recordProjection({
    estimatedTokens: compacted.projection.estimatedTokens,
    availableInputTokens: compacted.projection.availableInputTokens,
    contextLimitTokens: contextLimit,
    omittedMessages: compacted.projection.omittedMessageIds.length,
    compactedRevision: Option.getOrUndefined(
      latestCompactionRevision(compacted.projection.messages),
    ),
  })
  yield* eventPublisher.publish(
    ModelContextProjected.make({
      sessionId: params.sessionId,
      branchId: params.branchId,
      estimatedTokens: compacted.projection.estimatedTokens,
      availableInputTokens: compacted.projection.availableInputTokens,
      contextLimitTokens: contextLimit,
      omittedMessages: compacted.projection.omittedMessageIds.length,
      compacted: compacted.compacted,
    }),
  )
  const prompt = toPrompt(compacted.projection.messages, { systemPrompt: resolved.systemPrompt })
  const toolkit = convertTools([...resolved.tools])
  modelRequest = {
    ...modelRequest,
    hints: { ...modelRequest.hints, maxTokens: MODEL_OUTPUT_RESERVE_TOKENS },
  }
  const rawStream = Stream.unwrap(
    resolveAdmittedModel(modelRequest).pipe(
      Effect.map((model) => {
        if (resolved.tools.length > 0) {
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
    formatStreamError: formatStreamErrorMessage,
    collect: <R>(
      effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
    ) =>
      // `ProviderAuthError` is a fail-closed credential-absence signal —
      // not retryable, not recoverable mid-turn. Let it escape so the RPC
      // seam surfaces the typed auth failure; narrow the retry scope to
      // transient `ProviderError` only.
      effect.pipe(
        retryProviderCall(DEFAULT_RETRY_CONFIG, {
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
            formatStreamError: formatStreamErrorMessage,
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
