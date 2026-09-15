import { DateTime, Effect, Match, Option, Predicate, Ref, Result, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  AgentName,
  type AgentName as AgentNameType,
  DEFAULT_AGENT_NAME,
} from "../../domain/agent.js"
import {
  ErrorOccurred,
  type EventEnvelope,
  type EventStoreError,
  MessageReceived,
  ModelContextProjected,
  ProviderRetrying,
  StreamEnded,
  StreamStarted,
  TurnCompleted,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import {
  type BranchId,
  InteractionRequestId,
  type MessageId,
  type SessionId,
  ToolCallId,
} from "../../domain/ids.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { ExternalToolRunner, type ProviderAuthError, TurnError } from "../../domain/driver.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import { assistantMessageIdForTurn, Message } from "../../domain/message.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import { calculateCost, ModelId, parseModelId } from "../../domain/model.js"
import { ModelRegistry } from "../model-registry.js"
import { ConfigService } from "../config-service.js"
import { GentPlatform } from "../gent-platform.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { WideEvent, WideEventBoundary, withWideEvent } from "../wide-event-boundary.js"
import { AgentLoopError, type QueuedTurnItem, type RunningState } from "./agent-loop.state.js"
import {
  ToolCallRecoveryOutcome,
  ToolCallRecoveryService,
} from "../../domain/tool-call-recovery.js"
import {
  continuationMessageIdForTurn,
  toolCallsFromMessage,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"
import {
  type ActiveStreamHandle,
  type CollectedTurnResponse,
  collectExternalTurnResponse,
  collectFailedModelTurnResponse,
  collectModelTurnResponse,
  emptyTurnMetrics,
  isObservableModelOutputPart,
  makeActiveStreamHandle,
  type TurnMetrics,
} from "./turn-response.js"
import {
  type AssistantResponsePart,
  findPersistedEvent,
  findPersistedToolResults,
  persistAssistantPartsWithBindings,
  persistMessageParts,
  persistMessageReceived,
  recordToolOutcome,
  type ToolResponsePart,
  ToolResultReplayError,
} from "./turn-persistence.js"
import { type ResolvedTurnContext, resolveTurnContext } from "./turn-resolve.js"
import { convertTools, ToolRunner, type ResolvedToolCapability } from "./tool-runner.js"
import { executeToolCalls, ToolInteractionPending } from "./turn-tool-execution.js"
import { ToolCallBindingStorage } from "../../storage/tool-call-binding-storage.js"
import {
  emptyTurnRecord,
  type PendingToolCall,
  type TurnRecord,
  turnRecordAtStep,
  TurnRecordStorage,
} from "../../storage/turn-record-storage.js"
import { ToolBindingReplayError } from "./tool-binding-replay.js"
import {
  processLocalReplayBindingKey,
  processLocalReplayResultKey,
  ProcessLocalToolReplay,
} from "./process-local-tool-replay.js"
import { type AgentLoopTurnProfile, runAgentLoopTurnProfile } from "./agent-loop.turn-profile.js"
import { resolveReplayToolBinding } from "./tool-binding-resolution.js"
import type { TurnInterruption } from "./turn-interruption.js"
import * as AiError from "effect/unstable/ai/AiError"
import type * as Response from "effect/unstable/ai/Response"
import { CurrentToolCall } from "./current-tool-call.js"
import { ProviderError } from "../../domain/provider-error.js"
import { StorageError } from "../../domain/storage-error.js"
import { toPrompt } from "../../providers/ai-transcript.js"
import { ModelResolver, type ResolveModelRequest } from "../../providers/model-resolver.js"
import { EventStorage } from "../../storage/event-storage.js"
import { SqlClient } from "effect/unstable/sql"
import { DriverRegistry } from "../extensions/driver-registry.js"
import {
  estimateTextTokens,
  estimateToolSchemaTokens,
  handoffAnchorWithinTurn,
  MODEL_OUTPUT_RESERVE_TOKENS,
  ModelContextBudget,
  ModelContextCapabilityError,
  ModelContextCapabilityFailure,
  type ModelContextProjection,
  ModelContextProjectionError,
  projectModelContext,
} from "../model-context.js"
import {
  type CompactionRequest,
  type CompactionSummary,
  ModelContextCompactor,
} from "../model-context-compactor.js"
import { type ContextDirective, ModelContextLedger } from "../model-context-ledger.js"
import {
  currentHandoffId,
  latestUserMessageId,
  messagesInCurrentWindow,
  windowMarkerMessage,
} from "../model-context-window.js"
import { driverRetryPolicy, retryProviderCall } from "../retry.js"
import {
  CurrentExtensionHostContext,
  provideCurrentHostCtx,
} from "./current-extension-host-context.js"
import { causeMessage } from "../../domain/guards.js"

/**
 * Where a turn's parts come from: the model stream or an external driver.
 *
 * `resolveTurnSource` projects the model context, applies the pending
 * context directive, and hands back a stream plus the collector that turns
 * it into a persisted response.
 */

const toolCallsFromResponseParts = (
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

type ExternalToolPersistence = {
  readonly assistantMessageId: MessageId
  readonly toolResultMessageId: MessageId
}

/** What the model asked the summary to focus on, when the pending directive is a compaction. */
const compactionInstructions = (
  directive: Option.Option<ContextDirective>,
): Option.Option<string> =>
  directive.pipe(
    Option.filter((value) => value._tag === "Compact"),
    Option.flatMap((value) => Option.fromUndefinedOr(value.instructions)),
  )

/** The handoff marker's record of what it replaced, taken from the history's ends. */
const summarizedRange = (history: ReadonlyArray<Message>, summary: CompactionSummary) =>
  Option.all([Option.fromUndefinedOr(history[0]), Option.fromUndefinedOr(history.at(-1))]).pipe(
    Option.map(([first, last]) => ({
      firstMessageId: first.id,
      lastMessageId: last.id,
      count: history.length,
      modelId: summary.modelId,
      usage: summary.usage,
    })),
  )

type WindowProjection = {
  readonly durableMessages: ReadonlyArray<Message>
  readonly compacted: boolean
}

/**
 * Where the window hands off and whether it must. The newest user message
 * anchors it; when the newest turn alone exceeds the budget the anchor moves
 * inside the turn, to a step boundary. Any other projection failure is the
 * caller's to raise.
 */
const handoffPlan = (
  window: ReadonlyArray<Message>,
  budget: ModelContextBudget,
  fit: Result.Result<ModelContextProjection, ModelContextProjectionError>,
): Result.Result<
  { readonly anchor: Option.Option<MessageId>; readonly overflowing: boolean },
  ModelContextProjectionError
> =>
  Result.match(fit, {
    onSuccess: (projection) =>
      Result.succeed({
        anchor: latestUserMessageId(window),
        overflowing: projection.omittedMessageIds.length > 0,
      }),
    onFailure: (error) => {
      if (error.failure._tag !== "BudgetExceeded") return Result.fail(error)
      return Result.succeed({ anchor: handoffAnchorWithinTurn(window, budget), overflowing: true })
    },
  })

/**
 * The window the model sees this step. A fresh window puts the issuer's notice
 * at the head; a handoff moves the history before the newest user message
 * behind one marker that summarizes it and names the ids it replaced. The
 * loop hands off when the window overflows, or when the model asked.
 */
const projectContextWindow = Effect.fn("TurnHelpers.projectContextWindow")(function* (params: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly modelId: ModelId
  readonly messages: ReadonlyArray<Message>
  readonly budget: ModelContextBudget
  readonly directive: Option.Option<ContextDirective>
  readonly project: (
    messages: ReadonlyArray<Message>,
  ) => Effect.Effect<ModelContextProjection, ModelContextProjectionError>
  readonly persist: (message: Message) => Effect.Effect<Message, StorageError | EventStoreError>
  readonly summaryModel: CompactionRequest["summaryModel"]
}) {
  const eventPublisher = yield* EventPublisher
  const now = yield* DateTime.nowAsDate
  let durableMessages = params.messages
  const newWindow = params.directive.pipe(Option.filter((value) => value._tag === "NewWindow"))
  const newWindowAnchor = Option.all([newWindow, latestUserMessageId(durableMessages)])
  if (Option.isSome(newWindowAnchor)) {
    const [directive, anchor] = newWindowAnchor.value
    const marker = yield* params.persist(
      windowMarkerMessage({
        sessionId: params.sessionId,
        branchId: params.branchId,
        keepFromMessageId: anchor,
        notice: directive.notice,
        createdAt: now,
      }),
    )
    durableMessages = [...durableMessages, marker]
  }

  const window = messagesInCurrentWindow(durableMessages)
  const fit = yield* Effect.result(params.project(window))
  const plan = yield* Effect.fromResult(handoffPlan(window, params.budget, fit))
  const anchor = plan.anchor.pipe(
    Option.flatMap((id) => Option.fromUndefinedOr(window.find((message) => message.id === id))),
  )
  const anchorIndex = Math.max(
    0,
    window.findIndex((m) => Option.contains(anchor, m)),
  )
  const history = window.slice(0, anchorIndex)
  const kept = window.slice(anchorIndex)
  const requested = params.directive.pipe(Option.exists((value) => value._tag === "Compact"))
  const overflowing = plan.overflowing
  // Summarising is an extension's job. With no compactor installed the
  // transcript is truncated and the omission is reported as usual.
  const compactor = yield* Effect.serviceOption(ModelContextCompactor)
  if (!(requested || overflowing) || history.length === 0 || Option.isNone(compactor)) {
    return { durableMessages, compacted: false } satisfies WindowProjection
  }
  const summary = yield* compactor.value
    .compact({
      modelId: params.modelId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      history,
      kept,
      budget: params.budget,
      instructions: Option.getOrUndefined(compactionInstructions(params.directive)),
      summaryModel: params.summaryModel,
    })
    .pipe(
      Effect.asSome,
      Effect.catchTag("ModelCompactionError", (error) =>
        // A summary that cannot be produced must not cost the turn: the window
        // is truncated instead, with a visible notice.
        Effect.gen(function* () {
          const plain = yield* params.project(window)
          yield* eventPublisher.publish(
            ErrorOccurred.make({
              sessionId: params.sessionId,
              branchId: params.branchId,
              error: `Context compaction failed (${error.reason}); continuing with ${plain.omittedMessageIds.length} older messages omitted`,
            }),
          )
          return Option.none()
        }),
      ),
    )
  const handoff = Option.all([summary, anchor]).pipe(
    Option.flatMap(([value, anchorMessage]) =>
      summarizedRange(history, value).pipe(
        Option.map((summarized) => ({ notice: value.notice, summarized, anchorMessage })),
      ),
    ),
  )
  if (Option.isNone(handoff))
    return { durableMessages, compacted: false } satisfies WindowProjection
  const marker = yield* params.persist(
    windowMarkerMessage({
      sessionId: params.sessionId,
      branchId: params.branchId,
      keepFromMessageId: handoff.value.anchorMessage.id,
      notice: handoff.value.notice,
      summarized: handoff.value.summarized,
      createdAt: now,
    }),
  )
  return {
    durableMessages: [...durableMessages, marker],
    compacted: true,
  } satisfies WindowProjection
})

const resolveTurnSource = Effect.fn("TurnHelpers.resolveTurnSource")(function* (params: {
  messageId: MessageId
  step: number
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
  let modelRequest: ResolveModelRequest = {
    modelId: resolved.modelId,
    hints: {
      temperature: resolved.temperature,
      reasoning: resolved.reasoning,
      cacheKey: params.sessionId,
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

  const retryPolicy = yield* driverRetryPolicy(driverRegistry, modelRequest)

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
const computeStreamEndedCost: (params: {
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

/**
 * What one model step produced, classified once from the collected response.
 * Policy (continue, stop, run tools) matches on this; nothing else inspects
 * the response parts, and the tag travels on the step's `StreamEnded` event.
 */
export const StepOutcome = Schema.TaggedUnion({
  Interrupted: {},
  /** The stream failed; `partialOutput` says whether observable output was saved first. */
  Failed: { partialOutput: Schema.Boolean },
  /** The external driver ran the whole step, tools included. */
  External: {},
  /** The model asked for tools; the response parts carry them. */
  ToolCalls: { count: Schema.Int },
  /** No tool calls: an answer, nothing at all, or output cut off at the limit. */
  Answered: { empty: Schema.Boolean, truncated: Schema.Boolean },
})
export type StepOutcome = Schema.Schema.Type<typeof StepOutcome>

export const classifyStep = (collected: CollectedTurnResponse): StepOutcome => {
  const observable = collected.responseParts.some(isObservableModelOutputPart)
  if (collected.interrupted) return StepOutcome.cases.Interrupted.make({})
  if (collected.streamFailed) return StepOutcome.cases.Failed.make({ partialOutput: observable })
  if (collected.driverKind === "external") return StepOutcome.cases.External.make({})
  const count = toolCallsFromResponseParts(collected.responseParts).length
  if (count > 0) return StepOutcome.cases.ToolCalls.make({ count })
  return StepOutcome.cases.Answered.make({
    empty: !observable,
    truncated: collected.responseParts.some(
      (part) => part.type === "finish" && part.reason === "length",
    ),
  })
}

const MAX_TURN_STEPS = 200
/** Continuation instructions one turn may persist after a failed, empty, or truncated step. */
const MAX_CONTINUATIONS_PER_TURN = 2
const CONTINUATION_INSTRUCTION =
  "Your previous reply was cut off by a provider error after partial output. The partial output is saved above. Continue from where you stopped. Do not repeat text you already wrote."

const EMPTY_RESPONSE_INSTRUCTION =
  "Your previous step returned no text and no tool calls. Answer the request now using the tool results above."

const TRUNCATED_RESPONSE_INSTRUCTION =
  "Your previous step hit the output limit before it finished, so its tool call was discarded. Retry in smaller steps: make one shorter tool call now and continue after its result."

export const TurnOutcome = Schema.TaggedUnion({
  Done: {},
  InteractionRequested: {
    pendingRequestId: InteractionRequestId,
    pendingToolCallId: Schema.String,
    currentTurnAgent: AgentName,
  },
})
export type TurnOutcome = Schema.Schema.Type<typeof TurnOutcome>

/** What the turn loop does after one step. */
const StepResult = Schema.TaggedUnion({
  Continue: { currentTurnAgent: AgentName },
  Stop: {
    currentTurnAgent: AgentName,
    interrupted: Schema.Boolean,
    streamFailed: Schema.Boolean,
    /** The model never produced an answer and no continuation is left. */
    unanswered: Schema.Boolean,
  },
  Interaction: { outcome: TurnOutcome },
})
type StepResult = Schema.Schema.Type<typeof StepResult>

type AgentLoopTurnExecutionContext = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly resolveTurnProfile: Effect.Effect<AgentLoopTurnProfile>
  readonly activeStreamRef: Ref.Ref<Option.Option<ActiveStreamHandle>>
  readonly turnMetricsRef: Ref.Ref<TurnMetrics>
  readonly turnInterruption: TurnInterruption
  readonly clearInFlightTurn: (
    messageId: QueuedTurnItem["message"]["id"],
  ) => Effect.Effect<boolean, AgentLoopError>
  readonly takeSteeringForStep: Effect.Effect<ReadonlyArray<QueuedTurnItem>, AgentLoopError>
}

export const makeAgentLoopTurnExecution = (scope: AgentLoopTurnExecutionContext) =>
  Effect.gen(function* () {
    const messageStorage = yield* MessageStorage
    const operations = yield* SessionOperationStorage
    const eventPublisher = yield* EventPublisher
    const storageTransaction = yield* makeStorageTransaction
    const configServiceForRun = yield* ConfigService
    const platform = yield* GentPlatform
    const toolBindingStorage = yield* ToolCallBindingStorage
    const turnRecordStorage = yield* TurnRecordStorage
    const processLocalReplay = yield* ProcessLocalToolReplay
    const clearProcessLocalReplayBindings = (assistantMessageId: string) =>
      processLocalReplay.clearBindingsWithPrefix(
        `${scope.sessionId}:${scope.branchId}:${assistantMessageId}:`,
      )
    const clearProcessLocalReplayBindingsForTurn = (messageId: string) =>
      processLocalReplay.clearBindingsWithPrefix(
        `${scope.sessionId}:${scope.branchId}:${messageId}:assistant:`,
      )
    const clearProcessLocalToolResultsForTurn = (messageId: string) =>
      processLocalReplay.clearResultsWithPrefix(
        `${scope.sessionId}:${scope.branchId}:${messageId}:tool-result:`,
      )

    const captureReplayToolBindings = Effect.fn("AgentLoop.captureReplayToolBindings")(
      function* (params: {
        readonly assistantMessageId: RunningState["message"]["id"]
        readonly toolCalls: ReadonlyArray<Prompt.ToolCallPart>
        readonly turnProfile: AgentLoopTurnProfile
      }) {
        const bindings = new Map<string, ResolvedToolCapability>()
        for (const toolCall of params.toolCalls) {
          const entry = yield* resolveReplayToolBinding({
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            assistantMessageId: params.assistantMessageId,
            toolCall,
            generationId: params.turnProfile.turnGenerationId,
          }).pipe(
            Effect.provideService(ToolCallBindingStorage, toolBindingStorage),
            Effect.provideService(ProcessLocalToolReplay, processLocalReplay),
            Effect.provideService(GentPlatform, platform),
          )
          bindings.set(toolCall.name, entry)
        }
        return bindings
      },
    )

    /**
     * The turn's durable position.
     *
     * One row per turn, keyed by the user message that opened it. The row is
     * written at each step boundary in the same transaction as that step's
     * messages, so a resumed turn reads one row instead of probing derived
     * message ids.
     */
    const turnRecordKey = (messageId: RunningState["message"]["id"]) => ({
      sessionId: scope.sessionId,
      branchId: scope.branchId,
      messageId,
    })

    const readTurnRecord = (messageId: RunningState["message"]["id"]) =>
      turnRecordStorage.get(turnRecordKey(messageId)).pipe(
        // A read failure must not end a turn that can still run: the probe
        // fallback in `resumeTurn` re-derives the position from the messages.
        Effect.catch((cause) =>
          Effect.logWarning("turn.record-read-failed").pipe(
            Effect.annotateLogs({ error: String(cause) }),
            Effect.as(emptyTurnRecord),
          ),
        ),
      )

    const writeTurnRecord = (messageId: RunningState["message"]["id"], record: TurnRecord) =>
      turnRecordStorage
        .put(turnRecordKey(messageId), record)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("turn.record-write-failed").pipe(
              Effect.annotateLogs({ error: String(cause) }),
            ),
          ),
        )

    /** The step opened: its assistant message committed, its calls are pending. */
    const openTurnStep = Effect.fn("AgentLoop.openTurnStep")(function* (params: {
      readonly messageId: RunningState["message"]["id"]
      readonly step: number
      readonly toolCalls: ReadonlyArray<Prompt.ToolCallPart>
    }) {
      const pendingToolCalls: ReadonlyArray<PendingToolCall> = params.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
      }))
      const current = yield* readTurnRecord(params.messageId)
      yield* writeTurnRecord(
        params.messageId,
        turnRecordAtStep({
          step: params.step - 1,
          continuations: current.continuations,
          pendingToolCalls,
        }),
      )
    })

    /** The step closed: every message it owns has committed. */
    const closeTurnStep = Effect.fn("AgentLoop.closeTurnStep")(function* (params: {
      readonly messageId: RunningState["message"]["id"]
      readonly step: number
    }) {
      const current = yield* readTurnRecord(params.messageId)
      yield* writeTurnRecord(
        params.messageId,
        turnRecordAtStep({
          step: Math.max(current.step, params.step),
          continuations: current.continuations,
          pendingToolCalls: [],
        }),
      )
    })

    const executeTools = Effect.fn("AgentLoop.executeTools")(function* (params: {
      messageId: RunningState["message"]["id"]
      step: number
      toolCalls: ReadonlyArray<Prompt.ToolCallPart>
      currentTurnAgent: AgentNameType
      toolBindings: ResolvedTurnContext["toolBindings"]
      hostToolBindings: ResolvedTurnContext["toolBindings"]
      recoveredResults?: ReadonlyArray<Prompt.ToolResultPart>
    }) {
      if (params.toolCalls.length === 0) return

      const toolResultMessageId = toolResultMessageIdForTurn(params.messageId, params.step)
      const assistantMessageId = assistantMessageIdForTurn(params.messageId, params.step)
      const resultKey = processLocalReplayResultKey({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        toolResultMessageId,
      })
      const existing = yield* messageStorage.getMessage(toolResultMessageId)
      if (!Predicate.isUndefined(existing)) {
        yield* processLocalReplay.removeResults(resultKey)
        yield* closeTurnStep({ messageId: params.messageId, step: params.step })
        return
      }

      const persistedResults = yield* findPersistedToolResults({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        assistantMessageId,
        toolCalls: params.toolCalls,
      }).pipe(
        Effect.catchIf(Schema.is(ToolResultReplayError), (error) =>
          Effect.gen(function* () {
            const failureParts = params.toolCalls.map((toolCall) =>
              Prompt.toolResultPart({
                id: toolCall.id,
                name: toolCall.name,
                isFailure: true,
                providerExecuted: false,
                result: {
                  error: error.message,
                  reason: "CorruptResult",
                },
              }),
            )
            yield* recordToolOutcome({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              toolResultMessageId,
              assistantMessageId,
              parts: failureParts,
            }).pipe(Effect.orDie)
            return yield* error
          }),
        ),
      )
      const localResults = yield* processLocalReplay.getResults(resultKey)
      const knownResults = new Map(localResults)
      for (const result of params.recoveredResults ?? []) knownResults.set(result.id, result)
      for (const [toolCallId, result] of persistedResults) {
        knownResults.set(toolCallId, result)
      }
      const pendingToolCalls = params.toolCalls.filter((toolCall) => !knownResults.has(toolCall.id))
      const executedResults = yield* executeToolCalls({
        hostToolBindings: params.hostToolBindings,
        assistantMessageId,
        toolCalls: pendingToolCalls,
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        currentTurnAgent: params.currentTurnAgent,
        toolBindings: params.toolBindings,
      }).pipe(
        Effect.tapError((error) => {
          if (error.completedResults.length === 0) return Effect.void
          const partial = new Map(localResults)
          for (const result of error.completedResults) partial.set(result.id, result)
          return processLocalReplay.setResults(resultKey, partial)
        }),
      )
      const executedById = new Map(executedResults.map((part) => [part.id, part]))
      const toolResults = params.toolCalls.flatMap((toolCall) => {
        const persisted = knownResults.get(toolCall.id)
        if (Predicate.isNotUndefined(persisted)) return [persisted]
        const executed = executedById.get(toolCall.id)
        if (Predicate.isNotUndefined(executed)) return [executed]
        return []
      })
      yield* recordToolOutcome({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        toolResultMessageId,
        assistantMessageId,
        parts: toolResults,
      })
      yield* processLocalReplay.removeResults(resultKey)
      yield* closeTurnStep({ messageId: params.messageId, step: params.step })
    })

    const collectTurnStream = Effect.fn("AgentLoop.collectTurnStream")(function* (params: {
      messageId: RunningState["message"]["id"]
      step: number
      resolved: ResolvedTurnContext
      activeStream: ActiveStreamHandle
    }) {
      const persistAssistantPartsLocal = (
        step: number,
        parts: ReadonlyArray<AssistantResponsePart>,
        createdAt?: Date,
      ) =>
        persistMessageParts({
          role: "assistant",
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: assistantMessageIdForTurn(params.messageId, step),
          parts,
          createdAt,
        })

      const persistAssistantPartsWithBindingsAt = (
        step: number,
        parts: ReadonlyArray<AssistantResponsePart>,
        createdAt?: Date,
      ) =>
        persistAssistantPartsWithBindings({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: assistantMessageIdForTurn(params.messageId, step),
          parts,
          toolBindings: params.resolved.toolBindings,
          storageTransaction,
          createdAt,
        }).pipe(
          Effect.tap((persisted) =>
            Effect.gen(function* () {
              if (Option.isNone(persisted) || !persisted.value.inserted) return
              for (const part of parts) {
                if (part.type !== "tool-call") continue
                const entry = params.resolved.toolBindings.get(part.name)
                if (Predicate.isNotUndefined(entry) && Predicate.isUndefined(entry.binding)) {
                  yield* processLocalReplay.setBinding(
                    processLocalReplayBindingKey({
                      sessionId: scope.sessionId,
                      branchId: scope.branchId,
                      assistantMessageId: assistantMessageIdForTurn(params.messageId, step),
                      toolCallId: part.id,
                    }),
                    { entry },
                  )
                }
              }
            }),
          ),
        )

      const persistToolPartsLocal = (
        step: number,
        parts: ReadonlyArray<ToolResponsePart>,
        createdAt?: Date,
      ) =>
        persistMessageParts({
          role: "tool",
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: toolResultMessageIdForTurn(params.messageId, step),
          parts,
          createdAt,
        })

      let nextExternalStep = params.step

      const source = yield* resolveTurnSource({
        messageId: params.messageId,
        step: params.step,
        resolved: params.resolved,
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        activeStream: params.activeStream,
        randomId: platform.randomId,
        persistExternalToolCall: (toolCall) => {
          const step = nextExternalStep
          if (step > MAX_TURN_STEPS) {
            return Effect.fail(
              new TurnError({
                message: `External turn exceeded the ${MAX_TURN_STEPS} tool step limit`,
              }),
            )
          }
          nextExternalStep += 1
          return persistAssistantPartsWithBindingsAt(step, [toolCall]).pipe(
            Effect.as({
              assistantMessageId: assistantMessageIdForTurn(params.messageId, step),
              toolResultMessageId: toolResultMessageIdForTurn(params.messageId, step),
            } satisfies ExternalToolPersistence),
            Effect.orDie,
          )
        },
      })

      if (Predicate.isUndefined(source)) {
        let driverKind: "model" | "external" = "model"
        const driver = params.resolved.driver
        if (Predicate.isNotUndefined(driver) && driver._tag === "external") driverKind = "external"
        const collected: CollectedTurnResponse = {
          responseParts: [],
          messageProjection: { assistant: [], tool: [] },
          interrupted: false,
          streamFailed: true,
          driverKind,
        }
        return { collected, outcome: classifyStep(collected) }
      }

      const eventPublisher = yield* EventPublisher
      const publishEventOrDie = (event: StreamStarted | StreamEnded) =>
        eventPublisher.publish(event).pipe(Effect.orDie)

      yield* publishEventOrDie(
        StreamStarted.make({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: params.messageId,
          step: params.step,
        }),
      )

      yield* Effect.logInfo("turn-stream.start").pipe(
        Effect.annotateLogs({
          agent: params.resolved.currentTurnAgent,
          driverKind: source.driverKind,
          model: params.resolved.modelId,
          driverId: source.driverId,
        }),
      )

      let collected: CollectedTurnResponse
      if (source.driverKind === "model") {
        collected = yield* source.collect(
          collectModelTurnResponse({
            messageId: params.messageId,
            step: params.step,
            turnStream: source.stream,
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            modelId: params.resolved.modelId,
            activeStream: params.activeStream,
            formatStreamError: source.formatStreamError,
          }),
        )
      } else {
        collected = yield* source.collect(
          collectExternalTurnResponse({
            messageId: params.messageId,
            assistantMessageId: assistantMessageIdForTurn(params.messageId, params.step),
            step: params.step,
            turnStream: source.stream,
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            activeStream: params.activeStream,
            formatStreamError: source.formatStreamError,
          }),
        )
      }

      const outcome = classifyStep(collected)
      let responseStep = params.step
      if (source.driverKind === "external") responseStep = nextExternalStep
      const assistantParts = collected.messageProjection.assistant
      const toolParts = collected.messageProjection.tool

      // A settled step: cost frozen into the boundary event, metrics folded,
      // parts persisted with their bindings.
      const settleStep = Effect.gen(function* () {
        const usage = Option.fromUndefinedOr(collected.messageProjection.usage)
        const streamEndedCost = yield* computeStreamEndedCost({
          modelId: params.resolved.modelId,
          usage,
        })
        yield* publishEventOrDie(
          StreamEnded.make({
            messageId: params.messageId,
            step: params.step,
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            usage: collected.messageProjection.usage,
            model: params.resolved.modelId,
            costUsd: Option.getOrUndefined(streamEndedCost),
            outcome: outcome._tag,
          }),
        )
        const { inputTokens, outputTokens } = Option.getOrElse(usage, () => ({
          inputTokens: 0,
          outputTokens: 0,
        }))
        const toolCallCount = toolCallsFromResponseParts(collected.responseParts).length
        yield* Effect.logInfo("stream.end").pipe(
          Effect.annotateLogs({
            driverKind: source.driverKind,
            outcome: outcome._tag,
            inputTokens,
            outputTokens,
            toolCallCount,
          }),
        )
        const usableCount = (count: number) => Number.isSafeInteger(count) && count >= 0
        yield* Ref.update(scope.turnMetricsRef, (m) => {
          const totalInput = m.inputTokens + inputTokens
          const totalOutput = m.outputTokens + outputTokens
          return {
            ...m,
            agent: params.resolved.currentTurnAgent,
            model: params.resolved.modelId,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            toolCallCount: m.toolCallCount + toolCallCount,
            steps: m.steps + 1,
            usageKnown:
              m.usageKnown &&
              Option.isSome(usage) &&
              usableCount(inputTokens) &&
              usableCount(outputTokens) &&
              usableCount(totalInput) &&
              usableCount(totalOutput),
          }
        })
        yield* persistAssistantPartsWithBindingsAt(responseStep, assistantParts)
        const stepToolCalls = assistantParts.filter(
          (part): part is Prompt.ToolCallPart => part.type === "tool-call",
        )
        yield* openTurnStep({
          messageId: params.messageId,
          step: responseStep,
          toolCalls: stepToolCalls,
        })
        yield* persistToolPartsLocal(responseStep, toolParts)
        // A step the model answered owns no unsettled call; a tool step is
        // closed by `executeTools` once its results commit.
        if (stepToolCalls.length === 0) {
          yield* closeTurnStep({ messageId: params.messageId, step: responseStep })
        }
      })

      yield* Match.type<StepOutcome>().pipe(
        Match.tagsExhaustive({
          Interrupted: () =>
            Effect.gen(function* () {
              yield* publishEventOrDie(
                StreamEnded.make({
                  messageId: params.messageId,
                  step: params.step,
                  sessionId: scope.sessionId,
                  branchId: scope.branchId,
                  interrupted: true,
                  outcome: "Interrupted",
                }),
              )
              yield* persistAssistantPartsLocal(responseStep, assistantParts)
            }),
          // The failure already ended the stream where it broke; keep what arrived.
          Failed: () =>
            Effect.gen(function* () {
              yield* persistAssistantPartsLocal(responseStep, assistantParts)
              yield* persistToolPartsLocal(responseStep, toolParts)
              yield* closeTurnStep({ messageId: params.messageId, step: responseStep })
            }),
          External: () => settleStep,
          ToolCalls: () => settleStep,
          Answered: () => settleStep,
        }),
      )(outcome)

      return { collected, outcome }
    })

    const executeToolsWithInteraction = (params: {
      messageId: RunningState["message"]["id"]
      step: number
      toolCalls: ReadonlyArray<Prompt.ToolCallPart>
      currentTurnAgent: AgentNameType
      toolBindings: ResolvedTurnContext["toolBindings"]
      hostToolBindings: ResolvedTurnContext["toolBindings"]
      recoveredResults?: ReadonlyArray<Prompt.ToolResultPart>
    }) =>
      executeTools(params).pipe(
        Effect.as(Option.none<ToolInteractionPending>()),
        Effect.catchIf(Schema.is(ToolInteractionPending), (pending) => Effect.succeedSome(pending)),
      )

    const interactionOutcome = (pending: ToolInteractionPending, currentTurnAgent: AgentNameType) =>
      StepResult.cases.Interaction.make({
        outcome: TurnOutcome.cases.InteractionRequested.make({
          pendingRequestId: pending.pending.requestId,
          pendingToolCallId: String(pending.toolCallId),
          currentTurnAgent,
        }),
      })

    const finalizeTurn = Effect.fn("AgentLoop.finalizeTurn")(function* (params: {
      messageId: RunningState["message"]["id"]
      startedAtMs: number
      turnInterrupted: boolean
      streamFailed: boolean
      unanswered: boolean
      currentAgent: AgentNameType
    }) {
      const extensionRegistry = yield* ExtensionRegistry
      const existingMessage = yield* messageStorage.getMessage(params.messageId)
      if (!Predicate.isUndefined(existingMessage?.turnDurationMs)) {
        const envelope = yield* findPersistedEvent({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          match: (candidate) =>
            candidate.event._tag === "TurnCompleted" &&
            candidate.event.messageId === params.messageId,
        })
        if (!Predicate.isUndefined(envelope)) {
          yield* eventPublisher.deliver(envelope)
        }
        return
      }

      const turnEndTime = yield* DateTime.now
      const turnDurationMs = DateTime.toEpochMillis(turnEndTime) - params.startedAtMs
      const metrics = yield* Ref.get(scope.turnMetricsRef)

      const envelope = yield* storageTransaction(
        Effect.gen(function* () {
          yield* messageStorage.updateMessageTurnDuration(params.messageId, turnDurationMs)
          const completionFields = {
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            messageId: params.messageId,
            durationMs: Number(turnDurationMs),
            streamFailed: params.streamFailed,
          }
          if (params.turnInterrupted) {
            Object.assign(completionFields, { interrupted: true })
          }
          if (params.unanswered) {
            Object.assign(completionFields, { unanswered: true })
          }
          if (metrics.steps > 0 && metrics.usageKnown) {
            Object.assign(completionFields, {
              usage: { inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens },
            })
          }
          return yield* eventPublisher.append(TurnCompleted.make(completionFields))
        }),
      )
      yield* eventPublisher.deliver(envelope)

      yield* Effect.logDebug("finalize.turn-after.start")
      yield* extensionRegistry.extensionHooks.emitTurnAfter({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        durationMs: Number(turnDurationMs),
        agentName: params.currentAgent,
        interrupted: params.turnInterrupted,
        usage: { inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens },
      })
      yield* Effect.logDebug("finalize.turn-after.done")

      yield* Effect.logInfo("turn.completed").pipe(
        Effect.annotateLogs({
          durationMs: Number(turnDurationMs),
          interrupted: params.turnInterrupted,
          unanswered: params.unanswered,
        }),
      )
      if (params.unanswered) {
        yield* Effect.logWarning("turn.unanswered").pipe(
          Effect.annotateLogs({ continuations: MAX_CONTINUATIONS_PER_TURN }),
        )
      }

      const wideEventFields = {
        actor: metrics.agent,
        model: metrics.model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        toolCallCount: metrics.toolCallCount,
        interrupted: params.turnInterrupted,
      }
      if (params.streamFailed && !params.turnInterrupted) {
        Object.assign(wideEventFields, { streamFailed: true })
      }
      if (params.unanswered) {
        Object.assign(wideEventFields, { unanswered: true })
      }
      yield* WideEvent.set(wideEventFields)
    })

    const resolveReplayHostBindings = Effect.fn("AgentLoop.resolveReplayHostBindings")(
      function* (params: {
        readonly state: RunningState
        readonly turnProfile: AgentLoopTurnProfile
        readonly nativeToolCalls: ReadonlyArray<Prompt.ToolCallPart>
        readonly toolBindings: Map<string, ResolvedToolCapability>
      }) {
        // A dispatching tool's inner calls need the turn's host bindings, so
        // recovery must rebuild them. A plain tool needs only its own. Which
        // tools dispatch is declared on the capability, not known by name.
        const dispatching = params.nativeToolCalls.filter((call) =>
          Option.match(Option.fromUndefinedOr(params.toolBindings.get(call.name)), {
            onNone: () => false,
            onSome: (entry) => entry.capability.dispatches === true,
          }),
        )
        if (dispatching.length === 0) return params.toolBindings
        const resolved = yield* resolveTurnContext({
          agentOverride: params.state.agentOverride,
          runSpec: params.state.runSpec,
          currentAgent: params.state.currentAgent,
          branchId: scope.branchId,
          sessionId: scope.sessionId,
          baseSections: params.turnProfile.turnBaseSections,
          interactive: params.state.interactive,
        })
        if (Predicate.isUndefined(resolved)) {
          return yield* new AgentLoopError({ message: "Recovery requires a selected agent" })
        }
        // A stored binding cannot restore authority the current agent policy
        // removed: a tool the agent no longer grants must not come back.
        for (const call of dispatching) {
          if (!resolved.toolBindings.has(call.name)) params.toolBindings.delete(call.name)
        }
        return resolved.hostToolBindings
      },
    )

    /**
     * Where a turn stands.
     *
     * The record answers in one read. Two cases still read messages:
     *
     * - The record names a pending step. Its assistant message carries the
     *   call arguments, which the row deliberately does not duplicate.
     * - The turn has no row. Either it is starting -- its first step has not
     *   committed yet, so there is nothing to resume -- or it was written
     *   before the record existed. The probe separates those two, and adopts
     *   whatever it derives, so it runs at most once per turn.
     */
    const resolveTurnPosition = Effect.fn("AgentLoop.resolveTurnPosition")(function* (
      messageId: RunningState["message"]["id"],
    ) {
      const settled: ReadonlyArray<Prompt.ToolCallPart> = []
      const noPendingStep = {
        step: 0,
        pendingAssistant: Option.none<Message>(),
        pendingToolCalls: settled,
      }
      const record = yield* readTurnRecord(messageId)
      if (record.pendingToolCalls.length > 0) {
        const pendingStep = record.step + 1
        const assistant = yield* messageStorage.getMessage(
          assistantMessageIdForTurn(messageId, pendingStep),
        )
        // A row naming a step whose assistant message is gone is stale: the
        // messages, never the row, decide what actually happened.
        if (Predicate.isNotUndefined(assistant)) {
          return {
            step: record.step,
            pendingAssistant: Option.some(assistant),
            pendingToolCalls: toolCallsFromMessage(assistant),
          }
        }
      } else if (record.step > 0 || record.continuations > 0) {
        return { ...noPendingStep, step: record.step }
      }

      // No usable row. Derive the position from the messages once, then adopt
      // it. A turn that is only starting exits on the first missing id.
      let lastCompletedStep = 0
      let pendingAssistant = Option.none<Message>()
      let pendingToolCalls: ReadonlyArray<Prompt.ToolCallPart> = []
      for (let step = 1; step <= MAX_TURN_STEPS; step++) {
        const existingAssistant = yield* messageStorage.getMessage(
          assistantMessageIdForTurn(messageId, step),
        )
        if (Predicate.isUndefined(existingAssistant)) break
        const toolCalls = toolCallsFromMessage(existingAssistant)
        if (toolCalls.length === 0) {
          lastCompletedStep = step
          continue
        }
        const existingResults = yield* messageStorage.getMessage(
          toolResultMessageIdForTurn(messageId, step),
        )
        if (Predicate.isUndefined(existingResults)) {
          pendingAssistant = Option.some(existingAssistant)
          pendingToolCalls = toolCalls
          break
        }
        lastCompletedStep = step
      }
      // A turn that has committed nothing owns no position worth storing.
      if (lastCompletedStep === 0 && Option.isNone(pendingAssistant)) return noPendingStep
      const derivedPending: ReadonlyArray<PendingToolCall> = pendingToolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
      }))
      yield* writeTurnRecord(
        messageId,
        turnRecordAtStep({
          step: lastCompletedStep,
          continuations: record.continuations,
          pendingToolCalls: derivedPending,
        }),
      )
      return { step: lastCompletedStep, pendingAssistant, pendingToolCalls }
    })

    const resumeTurn = Effect.fn("AgentLoop.resumeTurn")(function* (params: {
      readonly state: RunningState
      readonly messageId: RunningState["message"]["id"]
      readonly interrupted: boolean
      readonly currentTurnAgent: AgentNameType
      readonly turnProfile: AgentLoopTurnProfile
    }) {
      if (params.interrupted) {
        return { step: 0, interaction: Option.none() }
      }

      const position = yield* resolveTurnPosition(params.messageId)
      const lastCompletedStep = position.step
      const pendingStep = position.step + 1
      if (Option.isNone(position.pendingAssistant)) {
        return { step: lastCompletedStep, interaction: Option.none() }
      }
      const pendingAssistant = position.pendingAssistant
      const pendingToolCalls = position.pendingToolCalls

      yield* Effect.logInfo("turn.resume-tools")
      const recoveredResults: Array<Prompt.ToolResultPart> = []
      const nativeToolCalls: Array<Prompt.ToolCallPart> = []
      // A tool that keeps durable receipts can settle a call the crash left in
      // flight; anything else is re-issued to the model. Which tools those are
      // is not the loop's business — no recovery service means re-issue all.
      const recovery = yield* Effect.serviceOption(ToolCallRecoveryService)
      for (const toolCall of pendingToolCalls) {
        const outcome: ToolCallRecoveryOutcome = yield* Option.match(recovery, {
          onNone: () =>
            Effect.succeed<ToolCallRecoveryOutcome>(
              ToolCallRecoveryOutcome.cases.NotRecovered.make({}),
            ),
          onSome: (service) =>
            service
              .recover({
                sessionId: scope.sessionId,
                branchId: scope.branchId,
                assistantMessageId: pendingAssistant.value.id,
                toolCall,
              })
              .pipe(
                runAgentLoopTurnProfile(params.turnProfile),
                Effect.mapError(
                  (cause) => new AgentLoopError({ message: "Tool call recovery failed", cause }),
                ),
              ),
        })
        if (outcome._tag === "Suspended") {
          return {
            step: pendingStep,
            interaction: Option.some(
              TurnOutcome.cases.InteractionRequested.make({
                pendingRequestId: outcome.requestId,
                pendingToolCallId: toolCall.id,
                currentTurnAgent: params.currentTurnAgent,
              }),
            ),
          }
        }
        if (outcome._tag === "Settled") {
          recoveredResults.push(outcome.result)
          continue
        }
        nativeToolCalls.push(toolCall)
      }
      const toolBindings = yield* captureReplayToolBindings({
        assistantMessageId: pendingAssistant.value.id,
        toolCalls: nativeToolCalls,
        turnProfile: params.turnProfile,
      }).pipe(
        Effect.catchIf(Schema.is(ToolBindingReplayError), (error) =>
          Effect.gen(function* () {
            const failureParts = nativeToolCalls.map((toolCall) =>
              Prompt.toolResultPart({
                id: toolCall.id,
                name: toolCall.name,
                isFailure: true,
                providerExecuted: false,
                result: { error: error.message, reason: error.reason },
              }),
            )
            const parts = [...recoveredResults, ...failureParts]
            yield* recordToolOutcome({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              toolResultMessageId: toolResultMessageIdForTurn(params.messageId, pendingStep),
              assistantMessageId: pendingAssistant.value.id,
              parts,
            }).pipe(Effect.orDie)
            return yield* error
          }),
        ),
      )
      const hostToolBindings = yield* resolveReplayHostBindings({
        state: params.state,
        turnProfile: params.turnProfile,
        nativeToolCalls,
        toolBindings,
      })
      const interactionSignal = yield* executeToolsWithInteraction({
        hostToolBindings,
        messageId: params.messageId,
        step: pendingStep,
        toolCalls: pendingToolCalls,
        currentTurnAgent: params.currentTurnAgent,
        toolBindings,
        recoveredResults,
      })
      if (Option.isNone(interactionSignal)) {
        yield* clearProcessLocalReplayBindings(pendingAssistant.value.id)
        return { step: pendingStep, interaction: Option.none() }
      }
      const pending = interactionSignal.value
      const outcome = interactionOutcome(pending, params.currentTurnAgent)
      return { step: 1, interaction: Option.some(outcome.outcome) }
    })

    /**
     * A safe step boundary: tool results are stored and no stream is open.
     * Steering admitted while the step ran joins the transcript here, so the
     * next model call reads it without an interrupted stream.
     */
    const deliverSteeringAtStepBoundary = Effect.fn("AgentLoop.deliverSteering")(function* () {
      const items = yield* scope.takeSteeringForStep
      for (const item of items) {
        // The message joins the transcript now. Its admission time could sort it
        // between a tool call and its result, which the projection rejects.
        yield* persistMessageReceived({
          message: { ...item.message, createdAt: yield* DateTime.nowAsDate },
        })
      }
    })

    /**
     * Narrow retry inside a turn: whatever the model did produce stays, a
     * durable instruction follows it, and the same turn runs one more model
     * step. Bounded per turn; a further failure ends the turn.
     *
     * Two callers share this. A stream that failed after partial output asks
     * the model to continue; a stream that succeeded with nothing at all asks
     * it to answer. Both would otherwise finalize a turn the caller cannot
     * distinguish from a real reply.
     */
    const continueWithinTurn = Effect.fn("AgentLoop.continueWithinTurn")(function* (params: {
      readonly messageId: RunningState["message"]["id"]
      readonly step: number
      readonly instruction: string
    }) {
      const record = yield* readTurnRecord(params.messageId)
      const used = record.continuations
      if (used >= MAX_CONTINUATIONS_PER_TURN) return false
      yield* persistMessageReceived({
        message: Message.cases.regular.make({
          id: continuationMessageIdForTurn(params.messageId, params.step),
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          role: "user",
          parts: [Prompt.textPart({ text: params.instruction })],
          createdAt: yield* DateTime.nowAsDate,
          metadata: { customType: "continuation", details: { step: params.step } },
        }),
      })
      yield* writeTurnRecord(
        params.messageId,
        turnRecordAtStep({
          step: record.step,
          continuations: used + 1,
          pendingToolCalls: record.pendingToolCalls,
        }),
      )
      yield* Effect.logInfo("turn.continue-within-turn").pipe(
        Effect.annotateLogs({ step: params.step, continuation: used + 1 }),
      )
      return true
    })

    const runTurnStep = Effect.fn("AgentLoop.runTurnStep")(function* (params: {
      readonly state: RunningState
      readonly step: number
      readonly currentTurnAgent: AgentNameType
      readonly turnProfile: AgentLoopTurnProfile
    }) {
      const resolved = yield* resolveTurnContext({
        agentOverride: params.state.agentOverride,
        runSpec: params.state.runSpec,
        currentAgent: params.state.currentAgent,
        branchId: scope.branchId,
        sessionId: scope.sessionId,
        baseSections: params.turnProfile.turnBaseSections,
        interactive: params.state.interactive,
      })
      const stopWith = (
        currentTurnAgent: AgentNameType,
        flags: { interrupted?: boolean; streamFailed?: boolean; unanswered?: boolean },
      ) =>
        StepResult.cases.Stop.make({
          currentTurnAgent,
          interrupted: false,
          streamFailed: false,
          unanswered: false,
          ...flags,
        })
      if (Predicate.isUndefined(resolved)) return stopWith(params.currentTurnAgent, {})

      const currentTurnAgent = resolved.currentTurnAgent
      if (params.step === 1) {
        yield* Ref.update(scope.turnMetricsRef, (m) => ({
          ...m,
          agent: currentTurnAgent,
          model: resolved.modelId,
        }))
      }
      if (yield* scope.turnInterruption.interrupted) {
        return stopWith(currentTurnAgent, { interrupted: true })
      }

      const attempt = yield* Effect.scoped(
        Effect.gen(function* () {
          const activeStream = yield* makeActiveStreamHandle
          yield* Ref.set(scope.activeStreamRef, Option.some(activeStream))
          return yield* collectTurnStream({
            messageId: params.state.message.id,
            step: params.step,
            resolved,
            activeStream,
          })
        }).pipe(Effect.ensuring(Ref.set(scope.activeStreamRef, Option.none()))),
      ).pipe(
        Effect.map(Result.succeed),
        Effect.catchIf(Schema.is(InteractionPendingError), (pending) =>
          Effect.succeed(Result.fail(pending)),
        ),
      )
      if (Result.isFailure(attempt)) {
        return StepResult.cases.Interaction.make({
          outcome: TurnOutcome.cases.InteractionRequested.make({
            pendingRequestId: attempt.failure.requestId,
            pendingToolCallId: "external",
            currentTurnAgent,
          }),
        })
      }
      const { collected, outcome } = attempt.success
      const stop = (flags: {
        interrupted?: boolean
        streamFailed?: boolean
        unanswered?: boolean
      }) => stopWith(currentTurnAgent, flags)
      const proceed = StepResult.cases.Continue.make({ currentTurnAgent })
      // Whatever the model did produce stays; a durable instruction follows it
      // and the same turn runs one more step. Once the budget is spent, stop.
      const continueOr = (instruction: string, otherwise: StepResult) =>
        continueWithinTurn({
          messageId: params.state.message.id,
          step: params.step,
          instruction,
        }).pipe(
          Effect.map((continued) => {
            if (continued) return proceed
            return otherwise
          }),
        )
      const runTools = Effect.gen(function* () {
        const interactionSignal = yield* executeToolsWithInteraction({
          hostToolBindings: resolved.hostToolBindings,
          messageId: params.state.message.id,
          step: params.step,
          toolCalls: toolCallsFromResponseParts(collected.responseParts),
          currentTurnAgent,
          toolBindings: resolved.toolBindings,
        })
        if (Option.isSome(interactionSignal)) {
          return interactionOutcome(interactionSignal.value, currentTurnAgent)
        }
        yield* clearProcessLocalReplayBindings(
          assistantMessageIdForTurn(params.state.message.id, params.step),
        )
        yield* deliverSteeringAtStepBoundary()
        return proceed
      })

      return yield* Match.type<StepOutcome>().pipe(
        Match.tagsExhaustive({
          Interrupted: () => Effect.succeed(stop({ interrupted: true })),
          Failed: ({ partialOutput }) => {
            if (!partialOutput) return Effect.succeed(stop({ streamFailed: true }))
            return continueOr(CONTINUATION_INSTRUCTION, stop({ streamFailed: true }))
          },
          External: () => Effect.succeed(stop({})),
          // A step with nothing observable answered nothing; one cut off at the
          // output limit lost what it was writing. Re-prompt rather than report
          // the fragment as the reply; once continuations are spent, say so.
          Answered: ({ empty, truncated }) => {
            if (!empty && !truncated) return Effect.succeed(stop({}))
            let instruction = EMPTY_RESPONSE_INSTRUCTION
            if (truncated) instruction = TRUNCATED_RESPONSE_INSTRUCTION
            return continueOr(instruction, stop({ unanswered: empty }))
          },
          ToolCalls: () => runTools,
        }),
      )(outcome)
    })

    const runTurn = Effect.fn("AgentLoop.runTurn")(function* (state: RunningState) {
      yield* Ref.set(scope.turnMetricsRef, emptyTurnMetrics())
      const cancelled = yield* operations
        .isTurnCancelled({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: state.message.id,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentLoopError({
                message: "Cannot read targeted cancellation",
                cause,
              }),
          ),
        )
      if (cancelled) yield* scope.turnInterruption.interrupt

      const turnProfile = yield* scope.resolveTurnProfile

      const provideTurnContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ConfigService, configServiceForRun),
          runAgentLoopTurnProfile(turnProfile),
        )

      let preserveReplayBindings = false
      return yield* Effect.gen(function* () {
        yield* persistMessageReceived({ message: state.message })
        yield* scope.clearInFlightTurn(state.message.id)
        let interrupted = yield* scope.turnInterruption.interrupted
        let streamFailed = false
        let unanswered = false
        let currentTurnAgent: AgentNameType = Option.getOrElse(
          Option.fromUndefinedOr(state.currentAgent),
          () => DEFAULT_AGENT_NAME,
        )

        const resumed = yield* resumeTurn({
          state,
          messageId: state.message.id,
          interrupted,
          currentTurnAgent,
          turnProfile,
        })
        let step = resumed.step
        if (Option.isSome(resumed.interaction)) {
          preserveReplayBindings = true
          return resumed.interaction.value
        }

        while (true) {
          step++
          if (step > MAX_TURN_STEPS) {
            yield* Effect.logWarning("turn.max-steps-exceeded").pipe(
              Effect.annotateLogs({ step, max: MAX_TURN_STEPS }),
            )
            break
          }

          if (yield* scope.turnInterruption.interrupted) {
            interrupted = true
            break
          }

          const stepResult = yield* runTurnStep({ state, step, currentTurnAgent, turnProfile })
          if (stepResult._tag === "Stop") {
            currentTurnAgent = stepResult.currentTurnAgent
            interrupted = stepResult.interrupted
            streamFailed = stepResult.streamFailed
            unanswered = stepResult.unanswered
            break
          }
          if (stepResult._tag === "Continue") {
            currentTurnAgent = stepResult.currentTurnAgent
            continue
          }
          preserveReplayBindings = true
          return stepResult.outcome
        }

        yield* finalizeTurn({
          startedAtMs: state.startedAtMs,
          messageId: state.message.id,
          turnInterrupted: interrupted,
          streamFailed,
          unanswered,
          currentAgent: currentTurnAgent,
        })
        return TurnOutcome.cases.Done.make({})
      })
        .pipe(provideTurnContext)
        .pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (!preserveReplayBindings) {
                yield* clearProcessLocalReplayBindingsForTurn(state.message.id)
                yield* clearProcessLocalToolResultsForTurn(state.message.id)
              }
            }),
          ),
        )
    })

    return { runTurn }
  })
