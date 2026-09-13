import { DateTime, Effect, Option, Predicate, Ref, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  AgentName,
  DEFAULT_AGENT_NAME,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { StreamEnded, StreamStarted, TurnCompleted } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { type BranchId, InteractionRequestId, type SessionId } from "../../domain/ids.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { TurnError } from "../../domain/driver.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import { Message, assistantMessageIdForTurn } from "../../domain/message.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import { ConfigService } from "../config-service.js"
import { GentPlatform } from "../gent-platform.js"
import { ExtensionRegistry } from "../extensions/registry.js"
import { WideEvent } from "../wide-event-boundary.js"
import { AgentLoopError, type QueuedTurnItem, type RunningState } from "./agent-loop.state.js"
import {
  ToolCallRecoveryOutcome,
  ToolCallRecoveryService,
} from "../../domain/tool-call-recovery.js"
import {
  toolCallsFromMessage,
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
  persistAssistantPartsWithBindings,
  persistMessageReceived,
  persistMessageParts,
  recordToolOutcome,
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
import { ToolCallBindingStorage } from "../../storage/tool-call-binding-storage.js"
import { ToolBindingReplayError } from "./tool-binding-replay.js"
import {
  processLocalReplayBindingKey,
  processLocalReplayResultKey,
  ProcessLocalToolReplay,
} from "./process-local-tool-replay.js"
import { runAgentLoopTurnProfile, type AgentLoopTurnProfile } from "./agent-loop.turn-profile.js"
import { resolveReplayToolBinding } from "./tool-binding-resolution.js"
import type { TurnInterruption } from "./turn-interruption.js"

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
      /** The model never produced an answer and no continuation is left. */
      readonly unanswered: boolean
    }
  | {
      readonly _tag: "interaction"
      readonly outcome: TurnOutcome
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
      const { inputTokens, outputTokens } = Option.getOrElse(usage, () => ({
        inputTokens: 0,
        outputTokens: 0,
      }))
      yield* Effect.logInfo("stream.end").pipe(
        Effect.annotateLogs({
          driverKind: source.driverKind,
          inputTokens,
          outputTokens,
          toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
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
          toolCallCount:
            m.toolCallCount + toolCallsFromResponseParts(collected.responseParts).length,
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
          hash: (input) => platform.hash("sha256", input),
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
        const toolCalls = toolCallsFromMessage(existingAssistant)
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
          parts: [Prompt.textPart({ text: params.instruction })],
          createdAt: yield* DateTime.nowAsDate,
          metadata: { customType: "continuation", details: { step: params.step } },
        }),
      })
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
        hash: (input) => platform.hash("sha256", input),
      })
      if (Predicate.isUndefined(resolved)) {
        return {
          _tag: "stop",
          currentTurnAgent: params.currentTurnAgent,
          interrupted: false,
          streamFailed: false,
          unanswered: false,
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
      if (yield* scope.turnInterruption.interrupted) {
        return {
          _tag: "stop",
          currentTurnAgent,
          interrupted: true,
          streamFailed: false,
          unanswered: false,
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
          unanswered: false,
        } satisfies TurnStepResult
      }
      if (collected.streamFailed) {
        const continued =
          collected.responseParts.some(isObservableModelOutputPart) &&
          (yield* continueWithinTurn({
            messageId: params.state.message.id,
            step: params.step,
            instruction: CONTINUATION_INSTRUCTION,
          }))
        if (continued) return { _tag: "continue", currentTurnAgent } satisfies TurnStepResult
        return {
          _tag: "stop",
          currentTurnAgent,
          interrupted: false,
          streamFailed: true,
          unanswered: false,
        } satisfies TurnStepResult
      }
      if (collected.driverKind === "external") {
        return {
          _tag: "stop",
          currentTurnAgent,
          interrupted: false,
          streamFailed: false,
          unanswered: false,
        } satisfies TurnStepResult
      }

      const toolCalls = toolCallsFromResponseParts(collected.responseParts)
      if (toolCalls.length === 0) {
        // A step with no tool calls normally means the model answered. A step
        // with no observable output either answered nothing at all: persisting
        // an empty parts list stores no message, so finalizing here reports a
        // successful turn that produced no reply. Re-prompt once instead.
        // A step cut off at the output limit lost whatever it was writing,
        // usually a tool call. Re-prompt for a smaller step instead of
        // reporting the fragment as the reply.
        const producedNothing = !collected.responseParts.some(isObservableModelOutputPart)
        const truncated = collected.responseParts.some(
          (part) => part.type === "finish" && part.reason === "length",
        )
        if (producedNothing || truncated) {
          let instruction = EMPTY_RESPONSE_INSTRUCTION
          if (truncated) instruction = TRUNCATED_RESPONSE_INSTRUCTION
          const continued = yield* continueWithinTurn({
            messageId: params.state.message.id,
            step: params.step,
            instruction,
          })
          if (continued) return { _tag: "continue", currentTurnAgent } satisfies TurnStepResult
        }
        // Continuations are spent and the model still said nothing. Say so on
        // the receipt rather than finalizing a turn that looks like a reply.
        return {
          _tag: "stop",
          currentTurnAgent,
          interrupted: false,
          streamFailed: false,
          unanswered: producedNothing,
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
          if (stepResult._tag === "stop") {
            currentTurnAgent = stepResult.currentTurnAgent
            interrupted = stepResult.interrupted
            streamFailed = stepResult.streamFailed
            unanswered = stepResult.unanswered
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
