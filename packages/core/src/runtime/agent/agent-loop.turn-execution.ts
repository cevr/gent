import { DateTime, Effect, Match, Option, Predicate, Ref, Result, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  AgentName,
  type AgentName as AgentNameType,
  DEFAULT_AGENT_NAME,
} from "../../domain/agent.js"
import { StreamEnded, StreamStarted, TurnCompleted } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { type BranchId, InteractionRequestId, type SessionId } from "../../domain/ids.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { TurnError } from "../../domain/driver.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { SessionOperationStorage } from "../../storage/session-operation-storage.js"
import { assistantMessageIdForTurn, Message } from "../../domain/message.js"
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
  continuationMessageIdForTurn,
  finalStepMessageIdForTurn,
  toolCallsFromMessage,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"
import {
  type ActiveStreamHandle,
  type CollectedTurnResponse,
  collectExternalTurnResponse,
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
import { type ResolvedToolCapability } from "./tool-runner.js"
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
import {
  computeStreamEndedCost,
  type ExternalToolPersistence,
  resolveTurnSource,
  toolCallsFromResponseParts,
} from "./turn-source.js"

/**
 * What one model step produced, classified once from the collected response.
 * Policy (continue, stop, run tools) matches on this; nothing else inspects
 * the response parts, and the tag travels on the step's `StreamEnded` event.
 */
export const StepOutcome = Schema.TaggedUnion({
  Interrupted: {},
  /** The stream failed; `partialOutput` says whether observable output was saved first. */
  Failed: { partialOutput: Schema.Boolean },
  /**
   * The external driver ran the whole step, tools included. `empty` says the
   * driver finished without producing anything observable.
   */
  External: { empty: Schema.Boolean },
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
  if (collected.driverKind === "external") {
    return StepOutcome.cases.External.make({ empty: !observable })
  }
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

/**
 * What the model is told on the last step its turn is allowed.
 *
 * The step runs with `toolChoice: "none"`, so this is not a request the model
 * can decline by calling one more tool: it is the only move left. Prior art:
 * opencode-v2 does the same at its own ceiling (`runner/llm.ts:221`).
 */
const MAX_STEPS_INSTRUCTION =
  "You have reached the maximum number of steps for this turn, so tools are now disabled. Do not attempt another tool call. Reply with text only: say that the step limit stopped you, summarise what you established, and name what is still unfinished."

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
  readonly peekSteeringForStep: Effect.Effect<ReadonlyArray<QueuedTurnItem>, AgentLoopError>
  readonly dropSteeringDelivered: (
    delivered: ReadonlyArray<QueuedTurnItem>,
  ) => Effect.Effect<void, AgentLoopError>
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
        interruption: scope.turnInterruption.awaitInterrupt,
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
      /** The last step the turn may run; it streams with tools disabled. */
      finalStep: boolean
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
        finalStep: params.finalStep,
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
        if (Predicate.isNotUndefined(driver) && driver._tag === "External") driverKind = "external"
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

      /**
       * The stream stopped before the step settled. Keep what arrived, and give
       * every tool call that never ran a failure result: a call with no result
       * makes the transcript unreadable for every later turn.
       */
      const persistCutStep = (reason: "Interrupted" | "StreamFailed") =>
        Effect.gen(function* () {
          yield* persistAssistantPartsLocal(responseStep, assistantParts)
          const settled = new Set(
            toolParts.filter((part) => part.type === "tool-result").map((part) => part.id),
          )
          const unrun = assistantParts
            .filter((part) => part.type === "tool-call")
            .filter((call) => !settled.has(call.id))
            .map((call) =>
              Prompt.toolResultPart({
                id: call.id,
                name: call.name,
                isFailure: true,
                providerExecuted: false,
                result: { error: "The tool did not run: the step stopped first.", reason },
              }),
            )
          yield* recordToolOutcome({
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            toolResultMessageId: toolResultMessageIdForTurn(params.messageId, responseStep),
            assistantMessageId: assistantMessageIdForTurn(params.messageId, responseStep),
            parts: [...toolParts, ...unrun],
          })
          yield* closeTurnStep({ messageId: params.messageId, step: responseStep })
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
              yield* persistCutStep("Interrupted")
            }),
          // The failure already ended the stream where it broke; keep what arrived.
          Failed: () => persistCutStep("StreamFailed"),
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
        streamFailed: params.streamFailed,
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
      const items = yield* scope.peekSteeringForStep
      for (const item of items) {
        // The message joins the transcript now. Its admission time could sort it
        // between a tool call and its result, which the projection rejects.
        //
        // `steering` marks it as answered by the turn it joined. Without the
        // mark it is a user-role message with no `TurnCompleted` of its own,
        // and a restart reads that as an unanswered turn and answers it twice.
        // Only delivery stamps it: an interjection that woke an idle branch
        // never reaches this boundary and must still recover.
        yield* persistMessageReceived({
          message: {
            ...item.message,
            createdAt: yield* DateTime.nowAsDate,
            metadata: { ...item.message.metadata, customType: "steering" },
          },
        })
      }
      // Dropped only once the transcript holds them. The queue write and the
      // message write cannot share a transaction, so the order decides which
      // way a crash between them fails: this way replays a delivery that
      // `persistMessageReceived` already treats as a no-op, the other way
      // loses input the branch accepted.
      yield* scope.dropSteeringDelivered(items)
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
      /**
       * The last step this turn may run. Set by `runTurn` when the step budget
       * is down to its final step, so the model answers instead of being cut
       * off mid-plan.
       */
      readonly finalStep: boolean
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
      // `resolveTurnContext` published `ErrorOccurred` and gave up — an unknown
      // agent, most often. The turn produced no answer, so say so rather than
      // publish a `TurnCompleted` no caller can tell from a reply.
      if (Predicate.isUndefined(resolved)) {
        return stopWith(params.currentTurnAgent, { unanswered: true })
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
        return stopWith(currentTurnAgent, { interrupted: true })
      }

      const attempt = yield* Effect.scoped(
        Effect.gen(function* () {
          const activeStream = yield* makeActiveStreamHandle
          yield* Ref.set(scope.activeStreamRef, Option.some(activeStream))
          return yield* collectTurnStream({
            messageId: params.state.message.id,
            step: params.step,
            finalStep: params.finalStep,
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
          // An external driver that finished without observable output answered
          // nothing. Leaving the flags false publishes a `TurnCompleted` that
          // reads like a reply, and `headless-runner.ts:122` exits 0 on it.
          External: ({ empty }) => Effect.succeed(stop({ unanswered: empty })),
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
            // Only reachable when the final step below said nothing at all: it
            // ran with tools disabled, so it had no way to ask for another.
            // Leaving the flags false publishes a `TurnCompleted` no caller can
            // tell from a reply, and `headless-runner.ts` reads exactly that
            // flag to pick its exit code, so `gent -H` would exit 0 having
            // printed nothing.
            unanswered = true
            yield* Effect.logWarning("turn.max-steps-exceeded").pipe(
              Effect.annotateLogs({ step, max: MAX_TURN_STEPS }),
            )
            break
          }

          if (yield* scope.turnInterruption.interrupted) {
            interrupted = true
            break
          }

          // The last step the budget allows. Rather than cut the turn off
          // mid-plan, tell the model its tools are gone and let it spend this
          // step writing the answer. Prior art: opencode-v2 does the same at
          // its ceiling (`runner/llm.ts:221`).
          const finalStep = step === MAX_TURN_STEPS
          if (finalStep) {
            yield* persistMessageReceived({
              message: Message.cases.regular.make({
                id: finalStepMessageIdForTurn(state.message.id),
                sessionId: scope.sessionId,
                branchId: scope.branchId,
                role: "user",
                parts: [Prompt.textPart({ text: MAX_STEPS_INSTRUCTION })],
                createdAt: yield* DateTime.nowAsDate,
                metadata: { customType: "max-steps", details: { step } },
              }),
            })
            yield* Effect.logWarning("turn.max-steps-final").pipe(
              Effect.annotateLogs({ step, max: MAX_TURN_STEPS }),
            )
          }

          const stepResult = yield* runTurnStep({
            state,
            step,
            finalStep,
            currentTurnAgent,
            turnProfile,
          })
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
