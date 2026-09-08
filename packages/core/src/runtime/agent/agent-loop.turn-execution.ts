import { DateTime, Effect, Option, Predicate, Ref, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentName,
  DEFAULT_AGENT_NAME,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { StreamEnded, StreamStarted, TurnCompleted } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import {
  InteractionRequestId,
  ToolCallId,
  type BranchId,
  type SessionId,
} from "../../domain/ids.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { TurnError } from "../../domain/driver.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import { Message } from "../../domain/message.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import { ConfigService } from "../config-service.js"
import { GentPlatform } from "../gent-platform.js"
import { provideHookHostContext } from "../extensions/extension-hook-context.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { WideEvent } from "../wide-event-boundary.js"
import { AgentLoopError, type QueuedTurnItem, type RunningState } from "./agent-loop.state.js"
import { CellExecutionStorage } from "../../storage/cell-execution-storage.js"
import { recoverCellExecution } from "../code-cell/cell-recovery.js"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  continuationMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"
import {
  collectExternalTurnResponse,
  collectModelTurnResponse,
  emptyTurnMetrics,
  makeActiveStreamHandle,
  type ActiveStreamHandle,
  isObservableModelOutputPart,
  type CollectedTurnResponse,
  type TurnMetrics,
} from "./turn-response.js"
import {
  findPersistedEvent,
  findPersistedToolResults,
  persistAssistantParts,
  persistAssistantPartsWithBindings,
  persistMessageReceived,
  persistToolParts,
  reconcileToolProjections,
  ToolResultReplayError,
  type AssistantResponsePart,
  type ToolResponsePart,
} from "./turn-persistence.js"
import { computeStreamEndedCost } from "./turn-pricing.js"
import { resolveTurnContext, type ResolvedTurnContext } from "./turn-resolve.js"
import {
  resolveTurnSource,
  toolCallsFromResponseParts,
  type ExternalToolPersistence,
} from "./turn-source.js"
import type { ResolvedToolCapability } from "./tool-runner.js"
import { executeToolCalls, ToolInteractionPending } from "./turn-tool-execution.js"
import { CurrentExtensionHostContext } from "./current-extension-host-context.js"
import { EventStorage } from "../../storage/event-storage.js"
import { ToolCallBindingStorage } from "../../storage/tool-call-binding-storage.js"
import { ToolBindingReplayError } from "./tool-binding-replay.js"
import {
  processLocalReplayBindingKey,
  processLocalReplayResultKey,
  ProcessLocalToolReplay,
} from "./process-local-tool-replay.js"
import {
  runAgentLoopTurnProfileOrLegacy,
  type AgentLoopTurnProfile,
} from "./agent-loop.turn-profile.js"
import { resolveReplayToolBinding } from "./tool-binding-resolution.js"

interface CollectedResult<A> {
  readonly _tag: "collected"
  readonly collected: A
}

interface InteractionPendingResult {
  readonly _tag: "interaction-pending"
  readonly pending: InteractionPendingError
}

type TurnStepResult =
  | {
      readonly _tag: "continue"
      readonly currentTurnAgent: AgentNameType
    }
  | {
      readonly _tag: "stop"
      readonly currentTurnAgent: AgentNameType
      readonly interrupted: boolean
      readonly streamFailed: boolean
    }
  | {
      readonly _tag: "interaction"
      readonly outcome: TurnOutcome
    }

const MAX_TURN_STEPS = 200
/** Continuation instructions one turn may persist after partial-output stream failures. */
const MAX_CONTINUATIONS_PER_TURN = 2
const CONTINUATION_INSTRUCTION =
  "Your previous reply was cut off by a provider error after partial output. The partial output is saved above. Continue from where you stopped. Do not repeat text you already wrote."

export const TurnOutcome = Schema.TaggedUnion({
  Done: {},
  InteractionRequested: {
    pendingRequestId: InteractionRequestId,
    pendingToolCallId: Schema.String,
    currentTurnAgent: AgentName,
  },
})
export type TurnOutcome = Schema.Schema.Type<typeof TurnOutcome>

export type AgentLoopTurnExecutionContext = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly resolveTurnProfile: Effect.Effect<AgentLoopTurnProfile>
  readonly activeStreamRef: Ref.Ref<Option.Option<ActiveStreamHandle>>
  readonly turnMetricsRef: Ref.Ref<TurnMetrics>
  readonly interruptedRef: Ref.Ref<boolean>
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
    const sql = yield* SqlClient.SqlClient
    const configServiceForRun = yield* ConfigService
    const platform = yield* GentPlatform
    const toolBindingStorage = yield* ToolCallBindingStorage
    const eventStorage = yield* EventStorage
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
            publication: params.turnProfile.turnPublication,
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
      const existing = yield* messageStorage.getMessage(toolResultMessageId)
      if (!Predicate.isUndefined(existing)) {
        yield* processLocalReplay.removeResults(
          processLocalReplayResultKey({
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            toolResultMessageId,
          }),
        )
        return
      }

      const persistedResults = yield* findPersistedToolResults({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        assistantMessageId: assistantMessageIdForTurn(params.messageId, params.step),
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
            yield* persistToolParts({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              messageId: toolResultMessageId,
              parts: failureParts,
            }).pipe(Effect.orDie)
            yield* reconcileToolProjections({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              assistantMessageId: assistantMessageIdForTurn(params.messageId, params.step),
              parts: failureParts,
            }).pipe(Effect.orDie)
            return yield* error
          }),
        ),
      )
      const localResults = yield* processLocalReplay.getResults(
        processLocalReplayResultKey({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          toolResultMessageId,
        }),
      )
      const knownResults = new Map(localResults)
      for (const result of params.recoveredResults ?? []) knownResults.set(result.id, result)
      for (const [toolCallId, result] of persistedResults) {
        knownResults.set(toolCallId, result)
      }
      const pendingToolCalls = params.toolCalls.filter((toolCall) => !knownResults.has(toolCall.id))
      const executedResults = yield* executeToolCalls({
        hostToolBindings: params.hostToolBindings,
        assistantMessageId: assistantMessageIdForTurn(params.messageId, params.step),
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
          return processLocalReplay.setResults(
            processLocalReplayResultKey({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              toolResultMessageId,
            }),
            partial,
          )
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
      yield* persistToolParts({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        messageId: toolResultMessageId,
        parts: toolResults,
      })
      yield* reconcileToolProjections({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        assistantMessageId: assistantMessageIdForTurn(params.messageId, params.step),
        parts: toolResults,
      })
      yield* processLocalReplay.removeResults(
        processLocalReplayResultKey({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          toolResultMessageId,
        }),
      )
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
        persistAssistantParts({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: assistantMessageIdForTurn(params.messageId, step),
          parts,
          createdAt,
          agentName: params.resolved.currentTurnAgent,
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
          agentName: params.resolved.currentTurnAgent,
        })
          .pipe(Effect.provideService(ToolCallBindingStorage, toolBindingStorage))
          .pipe(Effect.provideService(MessageStorage, messageStorage))
          .pipe(Effect.provideService(EventPublisher, eventPublisher))
          .pipe(Effect.provideService(EventStorage, eventStorage))
          .pipe(
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
                      {
                        entry,
                        generationId: Option.fromUndefinedOr(params.resolved.turnGenerationId),
                      },
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
        persistToolParts({
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
        hash: (input) => platform.hash("sha256", input),
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
        persistExternalToolResult: (persistence, result) =>
          persistToolParts({
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            messageId: persistence.toolResultMessageId,
            parts: [result],
          })
            .pipe(Effect.provideService(MessageStorage, messageStorage))
            .pipe(Effect.provideService(EventPublisher, eventPublisher))
            .pipe(Effect.provideService(EventStorage, eventStorage))
            .pipe(Effect.provideService(SqlClient.SqlClient, sql))
            .pipe(Effect.asVoid, Effect.orDie),
      })

      if (Predicate.isUndefined(source)) {
        return {
          responseParts: [],
          messageProjection: { assistant: [], tool: [] },
          interrupted: false,
          streamFailed: true,
          driverKind: (() => {
            let kind: "model" | "external" = "model"
            const driver = params.resolved.driver
            if (Predicate.isNotUndefined(driver) && driver._tag === "external") kind = "external"
            return kind
          })(),
        }
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
            retryPreOutputFailures: true,
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

      let responseStep = params.step
      if (source.driverKind === "external") responseStep = nextExternalStep

      if (collected.interrupted) {
        yield* publishEventOrDie(
          StreamEnded.make({
            messageId: params.messageId,
            step: params.step,
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            interrupted: true,
          }),
        )
        yield* persistAssistantPartsLocal(responseStep, collected.messageProjection.assistant)
        return collected
      }

      if (collected.streamFailed) {
        yield* persistAssistantPartsLocal(responseStep, collected.messageProjection.assistant)
        yield* persistToolPartsLocal(responseStep, collected.messageProjection.tool)
        return collected
      }

      const streamEndedCost = yield* computeStreamEndedCost({
        modelId: params.resolved.modelId,
        usage: Option.fromUndefinedOr(collected.messageProjection.usage),
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
        }),
      )
      const usage = Option.fromUndefinedOr(collected.messageProjection.usage)
      const inputTokens = Option.getOrElse(usage, () => ({
        inputTokens: 0,
        outputTokens: 0,
      })).inputTokens
      const outputTokens = Option.getOrElse(usage, () => ({
        inputTokens: 0,
        outputTokens: 0,
      })).outputTokens
      yield* Effect.logInfo("stream.end").pipe(
        Effect.annotateLogs({
          driverKind: source.driverKind,
          inputTokens,
          outputTokens,
          toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
        }),
      )

      yield* Ref.update(scope.turnMetricsRef, (m) => ({
        ...m,
        agent: params.resolved.currentTurnAgent,
        model: params.resolved.modelId,
        inputTokens: m.inputTokens + inputTokens,
        outputTokens: m.outputTokens + outputTokens,
        toolCallCount: m.toolCallCount + toolCallsFromResponseParts(collected.responseParts).length,
      }))

      yield* persistAssistantPartsWithBindingsAt(
        responseStep,
        collected.messageProjection.assistant,
      )
      yield* persistToolPartsLocal(responseStep, collected.messageProjection.tool)

      return collected
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

    const interactionOutcome = (
      pending: ToolInteractionPending,
      currentTurnAgent: AgentNameType,
    ): Extract<TurnStepResult, { readonly _tag: "interaction" }> =>
      ({
        _tag: "interaction",
        outcome: TurnOutcome.cases.InteractionRequested.make({
          pendingRequestId: pending.pending.requestId,
          pendingToolCallId: String(pending.toolCallId),
          currentTurnAgent,
        }),
      }) satisfies Extract<TurnStepResult, { readonly _tag: "interaction" }>

    const finalizeTurn = Effect.fn("AgentLoop.finalizeTurn")(function* (params: {
      messageId: RunningState["message"]["id"]
      startedAtMs: number
      turnInterrupted: boolean
      streamFailed: boolean
      currentAgent: AgentNameType
    }) {
      const extensionRegistry = yield* ExtensionRegistry
      const hostCtx = yield* CurrentExtensionHostContext
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
          return yield* eventPublisher.append(TurnCompleted.make(completionFields))
        }),
      )
      yield* eventPublisher.deliver(envelope)

      yield* Effect.logDebug("finalize.turn-after.start")
      const metrics = yield* Ref.get(scope.turnMetricsRef)
      yield* extensionRegistry.extensionHooks
        .emitTurnAfter({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          durationMs: Number(turnDurationMs),
          agentName: params.currentAgent,
          interrupted: params.turnInterrupted,
          usage: { inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens },
        })
        .pipe(provideHookHostContext(hostCtx))
      yield* Effect.logDebug("finalize.turn-after.done")

      yield* Effect.logInfo("turn.completed").pipe(
        Effect.annotateLogs({
          durationMs: Number(turnDurationMs),
          interrupted: params.turnInterrupted,
        }),
      )

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
      yield* WideEvent.set(wideEventFields)
    })

    const resolveReplayHostBindings = Effect.fn("AgentLoop.resolveReplayHostBindings")(
      function* (params: {
        readonly state: RunningState
        readonly turnProfile: AgentLoopTurnProfile
        readonly nativeToolCalls: ReadonlyArray<Prompt.ToolCallPart>
        readonly toolBindings: Map<string, ResolvedToolCapability>
      }) {
        if (!params.nativeToolCalls.some((call) => call.name === "cell")) return params.toolBindings
        const resolved = yield* resolveTurnContext({
          agentOverride: params.state.agentOverride,
          runSpec: params.state.runSpec,
          currentAgent: params.state.currentAgent,
          branchId: scope.branchId,
          sessionId: scope.sessionId,
          baseSections: params.turnProfile.turnBaseSections,
          interactive: params.state.interactive,
          turnPublication: params.turnProfile.turnPublication,
          hash: (input) => platform.hash("sha256", input),
        })
        if (Predicate.isUndefined(resolved)) {
          return yield* new AgentLoopError({ message: "Cell recovery requires a selected agent" })
        }
        // A stored binding cannot restore authority removed by the current agent policy.
        if (!resolved.toolBindings.has("cell")) params.toolBindings.delete("cell")
        return resolved.hostToolBindings
      },
    )

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

      let lastCompletedStep = 0
      let pendingAssistant = Option.none<Message>()
      let pendingToolCalls: ReadonlyArray<Prompt.ToolCallPart> = []
      let pendingStep = 0
      for (let step = 1; step <= MAX_TURN_STEPS; step++) {
        const existingAssistant = yield* messageStorage.getMessage(
          assistantMessageIdForTurn(params.messageId, step),
        )
        if (Predicate.isUndefined(existingAssistant)) break
        const toolCalls = assistantDraftFromMessage(existingAssistant).toolCalls
        if (toolCalls.length === 0) {
          lastCompletedStep = step
          continue
        }
        const existingResults = yield* messageStorage.getMessage(
          toolResultMessageIdForTurn(params.messageId, step),
        )
        if (Predicate.isUndefined(existingResults)) {
          pendingAssistant = Option.some(existingAssistant)
          pendingToolCalls = toolCalls
          pendingStep = step
          break
        }
        lastCompletedStep = step
      }
      if (Option.isNone(pendingAssistant)) {
        return { step: lastCompletedStep, interaction: Option.none() }
      }

      yield* Effect.logInfo("turn.resume-tools")
      const recoveredResults: Array<Prompt.ToolResultPart> = []
      const nativeToolCalls: Array<Prompt.ToolCallPart> = []
      for (const toolCall of pendingToolCalls) {
        if (toolCall.name !== "cell") {
          nativeToolCalls.push(toolCall)
          continue
        }
        const cell = {
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          assistantMessageId: pendingAssistant.value.id,
          toolCallId: ToolCallId.make(toolCall.id),
        }
        const cells = yield* CellExecutionStorage
        const saved = yield* cells.get(cell)
        if (Option.isNone(saved)) {
          nativeToolCalls.push(toolCall)
          continue
        }
        const turnPublication = params.turnProfile.turnPublication
        if (Predicate.isUndefined(turnPublication)) {
          return yield* new AgentLoopError({
            message: "Cell recovery requires a live turn publication",
          })
        }
        const recovered = yield* recoverCellExecution({
          cell,
          profile: { ...params.turnProfile, turnPublication },
        }).pipe(
          Effect.asSome,
          Effect.catchTag("CellToolCallSuspended", (suspended) => Effect.succeed(suspended)),
          Effect.mapError(
            (cause) => new AgentLoopError({ message: "Cell recovery failed", cause }),
          ),
        )
        if (recovered._tag === "CellToolCallSuspended") {
          return {
            step: pendingStep,
            interaction: Option.some(
              TurnOutcome.cases.InteractionRequested.make({
                pendingRequestId: recovered.pending.requestId,
                pendingToolCallId: toolCall.id,
                currentTurnAgent: params.currentTurnAgent,
              }),
            ),
          }
        }
        if (Option.isSome(recovered)) recoveredResults.push(recovered.value)
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
            yield* persistToolParts({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              messageId: toolResultMessageIdForTurn(params.messageId, pendingStep),
              parts,
            }).pipe(Effect.orDie)
            yield* reconcileToolProjections({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
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
        yield* persistMessageReceived({ message: item.message })
      }
    })

    /**
     * Narrow retry after partial output: the partial assistant message stays,
     * a durable continuation instruction follows it, and the same turn runs one
     * more model step. Bounded per turn; a further failure ends the turn.
     */
    const continueAfterPartialOutput = Effect.fn("AgentLoop.continueAfterPartialOutput")(
      function* (params: {
        readonly messageId: RunningState["message"]["id"]
        readonly step: number
        readonly collected: CollectedTurnResponse
      }) {
        if (!params.collected.responseParts.some(isObservableModelOutputPart)) return false
        let used = 0
        for (let step = 1; step < params.step; step++) {
          const existing = yield* messageStorage.getMessage(
            continuationMessageIdForTurn(params.messageId, step),
          )
          if (Predicate.isNotUndefined(existing)) used += 1
        }
        if (used >= MAX_CONTINUATIONS_PER_TURN) return false
        yield* persistMessageReceived({
          message: Message.cases.regular.make({
            id: continuationMessageIdForTurn(params.messageId, params.step),
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            role: "user",
            parts: [Prompt.textPart({ text: CONTINUATION_INSTRUCTION })],
            createdAt: yield* DateTime.nowAsDate,
            metadata: { customType: "continuation", details: { step: params.step } },
          }),
        })
        yield* Effect.logInfo("turn.continue-after-partial-output").pipe(
          Effect.annotateLogs({ step: params.step, continuation: used + 1 }),
        )
        return true
      },
    )

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
        turnPublication: params.turnProfile.turnPublication,
        hash: (input) => platform.hash("sha256", input),
      })
      if (Predicate.isUndefined(resolved)) {
        return {
          _tag: "stop",
          currentTurnAgent: params.currentTurnAgent,
          interrupted: false,
          streamFailed: false,
        } satisfies TurnStepResult
      }

      const currentTurnAgent = resolved.currentTurnAgent
      if (params.step === 1) {
        yield* Ref.update(scope.turnMetricsRef, (m) => ({
          ...m,
          agent: currentTurnAgent,
          model: resolved.modelId,
        }))
      }
      if (yield* Ref.get(scope.interruptedRef)) {
        return {
          _tag: "stop",
          currentTurnAgent,
          interrupted: true,
          streamFailed: false,
        } satisfies TurnStepResult
      }

      const collectedOrPending = yield* Effect.scoped(
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
        Effect.map(
          (collected) =>
            ({ _tag: "collected", collected }) satisfies CollectedResult<typeof collected>,
        ),
        Effect.catchIf(Schema.is(InteractionPendingError), (pending) =>
          Effect.succeed({
            _tag: "interaction-pending",
            pending,
          } satisfies InteractionPendingResult),
        ),
      )
      if (collectedOrPending._tag === "interaction-pending") {
        return {
          _tag: "interaction",
          outcome: TurnOutcome.cases.InteractionRequested.make({
            pendingRequestId: collectedOrPending.pending.requestId,
            pendingToolCallId: "external",
            currentTurnAgent,
          }),
        } satisfies TurnStepResult
      }

      const { collected } = collectedOrPending
      if (collected.interrupted) {
        return {
          _tag: "stop",
          currentTurnAgent,
          interrupted: true,
          streamFailed: false,
        } satisfies TurnStepResult
      }
      if (collected.streamFailed) {
        const continued = yield* continueAfterPartialOutput({
          messageId: params.state.message.id,
          step: params.step,
          collected,
        })
        if (continued) return { _tag: "continue", currentTurnAgent } satisfies TurnStepResult
        return {
          _tag: "stop",
          currentTurnAgent,
          interrupted: false,
          streamFailed: true,
        } satisfies TurnStepResult
      }
      if (collected.driverKind === "external") {
        return {
          _tag: "stop",
          currentTurnAgent,
          interrupted: false,
          streamFailed: false,
        } satisfies TurnStepResult
      }

      const toolCalls = toolCallsFromResponseParts(collected.responseParts)
      if (toolCalls.length === 0) {
        return {
          _tag: "stop",
          currentTurnAgent,
          interrupted: false,
          streamFailed: false,
        } satisfies TurnStepResult
      }
      const interactionSignal = yield* executeToolsWithInteraction({
        hostToolBindings: resolved.hostToolBindings,
        messageId: params.state.message.id,
        step: params.step,
        toolCalls,
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
      return { _tag: "continue", currentTurnAgent } satisfies TurnStepResult
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
      if (cancelled) yield* Ref.set(scope.interruptedRef, true)

      const turnProfile = yield* scope.resolveTurnProfile

      const provideTurnContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ConfigService, configServiceForRun),
          runAgentLoopTurnProfileOrLegacy(turnProfile),
        )

      let preserveReplayBindings = false
      return yield* Effect.gen(function* () {
        yield* persistMessageReceived({ message: state.message })
        yield* scope.clearInFlightTurn(state.message.id)
        let interrupted = yield* Ref.get(scope.interruptedRef)
        let streamFailed = false
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

          if (yield* Ref.get(scope.interruptedRef)) {
            interrupted = true
            break
          }

          const stepResult = yield* runTurnStep({ state, step, currentTurnAgent, turnProfile })
          if (stepResult._tag === "stop") {
            currentTurnAgent = stepResult.currentTurnAgent
            interrupted = stepResult.interrupted
            streamFailed = stepResult.streamFailed
            break
          }
          if (stepResult._tag === "continue") {
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
