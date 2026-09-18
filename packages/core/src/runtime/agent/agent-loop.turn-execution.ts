import { DateTime, Effect, Match, Option, Predicate, Ref, Result, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  AgentName,
  type AgentName as AgentNameType,
  DEFAULT_AGENT_NAME,
} from "../../domain/agent.js"
import { EventPublisher, StreamEnded, StreamStarted, TurnCompleted } from "../../domain/event.js"
import { omitUndefined } from "../../domain/guards.js"
import { type BranchId, InteractionRequestId, type SessionId } from "../../domain/ids.js"
import { InteractionPendingError } from "../../domain/interaction.js"
import { TurnError } from "../../domain/driver.js"
import {
  emptyTurnRecord,
  makeStorageTransaction,
  MessageStorage,
  type PendingToolCall,
  SessionOperationStorage,
  ToolCallBindingStorage,
  type TurnRecord,
  turnRecordAtStep,
  TurnRecordStorage,
} from "../../storage/storage.js"
import { Message } from "../../domain/message.js"
import { ConfigService } from "../config.js"
import { GentPlatform } from "../gent-platform.js"
import { ExtensionRegistry } from "../extension-host.js"
import { WideEvent } from "../wide-event-boundary.js"
import { AgentLoopError, asAgentLoopError, type RunningState } from "../../domain/agent-loop.js"
import type { LoopInbox } from "./loop-inbox.js"
import {
  executeToolCalls,
  processLocalReplayBindingKey,
  processLocalReplayResultKey,
  ProcessLocalToolReplay,
  type ResolvedToolCapability,
  resolveReplayToolBinding,
  ToolBindingReplayError,
  ToolCallRecoveryOutcome,
  ToolCallRecoveryService,
  ToolInteractionPending,
  type TurnInterruption,
} from "../tools.js"
import {
  continuationMessageIdForTurn,
  finalStepMessageIdForTurn,
  type StepAddress,
  stepAddress,
  toolCallsFromMessage,
} from "./agent-loop.utils.js"
import {
  type ActiveStreamHandle,
  type CollectedTurnResponse,
  collectExternalTurnResponse,
  collectModelTurnResponse,
  isObservableModelOutputPart,
  makeActiveStreamHandle,
} from "./turn-response.js"
import {
  type AssistantResponsePart,
  findPersistedEvent,
  findPersistedToolResults,
  persistAssistantPartsWithBindings,
  persistMessageParts,
  persistMessageReceived,
  recordToolOutcome,
  ToolResultReplayError,
} from "./turn-persistence.js"
import { type ResolvedTurnContext, resolveTurnContext } from "./turn-resolve.js"
import { type AgentLoopTurnProfile, runAgentLoopTurnProfile } from "./agent-loop.turn-profile.js"
import type { TurnLedger } from "./turn-ledger.js"
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

/**
 * A flag a receipt carries only when it happened. A present `false` would read
 * as a receipt that the turn was not interrupted, which historical receipts
 * cannot make, so `false` becomes absent instead.
 */
const flagWhenTrue = (value: boolean): Option.Option<true> => {
  if (value) return Option.some(true)
  return Option.none()
}

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

/**
 * End the turn after this step. The three flags default to false, so a caller
 * names only the one that happened — and a step that simply finished names
 * none.
 */
const endStep = (
  currentTurnAgent: AgentNameType,
  reason: {
    readonly interrupted?: boolean
    readonly streamFailed?: boolean
    readonly unanswered?: boolean
  },
) =>
  StepResult.cases.Stop.make({
    currentTurnAgent,
    interrupted: reason.interrupted ?? false,
    streamFailed: reason.streamFailed ?? false,
    unanswered: reason.unanswered ?? false,
  })

type AgentLoopTurnExecutionContext = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly resolveTurnProfile: Effect.Effect<AgentLoopTurnProfile>
  readonly activeStreamRef: Ref.Ref<Option.Option<ActiveStreamHandle>>
  readonly turnLedger: TurnLedger
  readonly turnInterruption: TurnInterruption
  readonly inbox: LoopInbox
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
     * written at each step boundary, after that step's messages and in its own
     * transaction, so a resumed turn reads one row instead of probing derived
     * message ids. A crash between the two writes leaves the row behind the
     * messages, so every read confirms it against them.
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

    /**
     * The turn's only write path: change the fields `change` names and carry
     * the rest forward. A field a writer does not mention keeps its value
     * instead of being restated, so a forgotten restatement can no longer
     * reset a turn's position.
     *
     * `base` is the record a caller has already read; `Option.none()` reads
     * the current record here.
     */
    const updateTurnRecord = (
      messageId: RunningState["message"]["id"],
      change: (current: TurnRecord) => Partial<TurnRecord>,
      base: Option.Option<TurnRecord> = Option.none(),
    ) =>
      Effect.gen(function* () {
        const current = yield* Option.match(base, {
          onNone: () => readTurnRecord(messageId),
          onSome: Effect.succeed,
        })
        const record = turnRecordAtStep({ ...current, ...change(current) })
        yield* turnRecordStorage
          .put(turnRecordKey(messageId), record)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("turn.record-write-failed").pipe(
                Effect.annotateLogs({ error: String(cause) }),
              ),
            ),
          )
      })

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
      yield* updateTurnRecord(params.messageId, () => ({
        step: params.step - 1,
        pendingToolCalls,
      }))
    })

    /** The step closed: every message it owns has committed. */
    const closeTurnStep = Effect.fn("AgentLoop.closeTurnStep")(function* (params: {
      readonly messageId: RunningState["message"]["id"]
      readonly step: number
    }) {
      yield* updateTurnRecord(params.messageId, (current) => ({
        step: Math.max(current.step, params.step),
        pendingToolCalls: [],
      }))
    })

    /**
     * Run the step's tool calls and commit their results.
     *
     * Answers with the interaction a tool parked on, if one did: a tool that
     * asks the user is not a failure, so it leaves as a value the step's
     * policy can match rather than as an error every caller must re-catch.
     */
    const executeTools = Effect.fn("AgentLoop.executeTools")(
      function* (params: {
        messageId: RunningState["message"]["id"]
        step: number
        toolCalls: ReadonlyArray<Prompt.ToolCallPart>
        currentTurnAgent: AgentNameType
        toolBindings: ResolvedTurnContext["toolBindings"]
        hostToolBindings: ResolvedTurnContext["toolBindings"]
        recoveredResults?: ReadonlyArray<Prompt.ToolResultPart>
      }) {
        if (params.toolCalls.length === 0) return Option.none<ToolInteractionPending>()

        const address = stepAddress(params.messageId, params.step)
        const resultKey = processLocalReplayResultKey({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          toolResultMessageId: address.toolResult,
        })
        const existing = yield* messageStorage.getMessage(address.toolResult)
        if (!Predicate.isUndefined(existing)) {
          yield* processLocalReplay.removeResults(resultKey)
          yield* closeTurnStep({ messageId: params.messageId, step: params.step })
          return Option.none<ToolInteractionPending>()
        }

        const persistedResults = yield* findPersistedToolResults({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          assistantMessageId: address.assistant,
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
                toolResultMessageId: address.toolResult,
                assistantMessageId: address.assistant,
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
        const pendingToolCalls = params.toolCalls.filter(
          (toolCall) => !knownResults.has(toolCall.id),
        )
        const executedResults = yield* executeToolCalls({
          interruption: scope.turnInterruption.awaitInterrupt,
          hostToolBindings: params.hostToolBindings,
          assistantMessageId: address.assistant,
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
          toolResultMessageId: address.toolResult,
          assistantMessageId: address.assistant,
          parts: toolResults,
        })
        yield* processLocalReplay.removeResults(resultKey)
        yield* closeTurnStep({ messageId: params.messageId, step: params.step })
        return Option.none<ToolInteractionPending>()
      },
      Effect.catchIf(Schema.is(ToolInteractionPending), (pending) => Effect.succeedSome(pending)),
    )

    const collectTurnStream = Effect.fn("AgentLoop.collectTurnStream")(function* (params: {
      messageId: RunningState["message"]["id"]
      step: number
      /** The last step the turn may run; it streams with tools disabled. */
      finalStep: boolean
      resolved: ResolvedTurnContext
      activeStream: ActiveStreamHandle
    }) {
      const persistAssistantPartsWithBindingsAt = (
        at: StepAddress,
        parts: ReadonlyArray<AssistantResponsePart>,
        createdAt?: Date,
      ) =>
        persistAssistantPartsWithBindings({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: at.assistant,
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
                      assistantMessageId: at.assistant,
                      toolCallId: part.id,
                    }),
                    { entry },
                  )
                }
              }
            }),
          ),
        )

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
          const at = stepAddress(params.messageId, step)
          return persistAssistantPartsWithBindingsAt(at, [toolCall]).pipe(
            Effect.as({
              assistantMessageId: at.assistant,
              toolResultMessageId: at.toolResult,
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
            assistantMessageId: stepAddress(params.messageId, params.step).assistant,
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
      // The step whose messages carry this response. An external driver settles
      // its own tool steps as it goes, so its response lands past `params.step`.
      const responseAddress = stepAddress(params.messageId, responseStep)
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
        yield* scope.turnLedger.noteStep({
          agent: params.resolved.currentTurnAgent,
          model: params.resolved.modelId,
          usage,
          toolCallCount,
        })
        yield* persistAssistantPartsWithBindingsAt(responseAddress, assistantParts)
        const stepToolCalls = assistantParts.filter(
          (part): part is Prompt.ToolCallPart => part.type === "tool-call",
        )
        yield* openTurnStep({
          messageId: params.messageId,
          step: responseStep,
          toolCalls: stepToolCalls,
        })
        yield* persistMessageParts({
          role: "tool",
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: responseAddress.toolResult,
          parts: toolParts,
        })
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
          yield* persistMessageParts({
            role: "assistant",
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            messageId: responseAddress.assistant,
            parts: assistantParts,
          })
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
            toolResultMessageId: responseAddress.toolResult,
            assistantMessageId: responseAddress.assistant,
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
      turnAgent: AgentNameType
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
      const metrics = yield* scope.turnLedger.total

      const envelope = yield* storageTransaction(
        Effect.gen(function* () {
          yield* messageStorage.updateMessageTurnDuration(params.messageId, turnDurationMs)
          // Token totals are a receipt only when every step reported usable
          // counts; a partial sum would read as the turn's true total.
          const usage = Option.map(flagWhenTrue(metrics.steps > 0 && metrics.usageKnown), () => ({
            inputTokens: metrics.inputTokens,
            outputTokens: metrics.outputTokens,
          }))
          return yield* eventPublisher.append(
            TurnCompleted.make({
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              messageId: params.messageId,
              durationMs: Number(turnDurationMs),
              streamFailed: params.streamFailed,
              ...omitUndefined({
                interrupted: Option.getOrUndefined(flagWhenTrue(params.turnInterrupted)),
                unanswered: Option.getOrUndefined(flagWhenTrue(params.unanswered)),
                usage: Option.getOrUndefined(usage),
              }),
            }),
          )
        }),
      )
      yield* eventPublisher.deliver(envelope)

      yield* Effect.logDebug("finalize.turn-after.start")
      yield* extensionRegistry.extensionHooks.emitTurnAfter({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        durationMs: Number(turnDurationMs),
        agentName: params.turnAgent,
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

      const failedWithoutInterrupt = params.streamFailed && !params.turnInterrupted
      yield* WideEvent.set({
        actor: metrics.agent,
        model: metrics.model,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        toolCallCount: metrics.toolCallCount,
        interrupted: params.turnInterrupted,
        ...omitUndefined({
          streamFailed: Option.getOrUndefined(flagWhenTrue(failedWithoutInterrupt)),
          unanswered: Option.getOrUndefined(flagWhenTrue(params.unanswered)),
        }),
      })
    })

    /** The turn context for a running turn: agent, prompt, model, and bindings. */
    const resolveForState = (state: RunningState, turnProfile: AgentLoopTurnProfile) =>
      resolveTurnContext({
        agentOverride: state.agentOverride,
        runSpec: state.runSpec,
        branchId: scope.branchId,
        sessionId: scope.sessionId,
        baseSections: turnProfile.turnBaseSections,
        interactive: state.interactive,
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
        const resolved = yield* resolveForState(params.state, params.turnProfile)
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
          stepAddress(messageId, pendingStep).assistant,
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
        // The row names no unsettled call. That is only true if the next step
        // never committed its messages: the row is written after them, and in
        // its own transaction, so a crash in between leaves a step's assistant
        // message durable while the row still names the step before it. Ask
        // the messages before believing the row, exactly as the branch above
        // does — otherwise the probe is skipped and the turn re-issues a step
        // whose tool calls are already on disk and will never be answered.
        const nextAssistant = yield* messageStorage.getMessage(
          stepAddress(messageId, record.step + 1).assistant,
        )
        if (Predicate.isUndefined(nextAssistant)) {
          return { ...noPendingStep, step: record.step }
        }
      }

      // No usable row. Derive the position from the messages once, then adopt
      // it. A turn that is only starting exits on the first missing id.
      let lastCompletedStep = 0
      let pendingAssistant = Option.none<Message>()
      let pendingToolCalls: ReadonlyArray<Prompt.ToolCallPart> = []
      for (let step = 1; step <= MAX_TURN_STEPS; step++) {
        const at = stepAddress(messageId, step)
        const existingAssistant = yield* messageStorage.getMessage(at.assistant)
        if (Predicate.isUndefined(existingAssistant)) break
        const toolCalls = toolCallsFromMessage(existingAssistant)
        if (toolCalls.length === 0) {
          lastCompletedStep = step
          continue
        }
        const existingResults = yield* messageStorage.getMessage(at.toolResult)
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
      yield* updateTurnRecord(
        messageId,
        () => ({ step: lastCompletedStep, pendingToolCalls: derivedPending }),
        Option.some(record),
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
                asAgentLoopError("Tool call recovery failed"),
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
              toolResultMessageId: stepAddress(params.messageId, pendingStep).toolResult,
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
      const interactionSignal = yield* executeTools({
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
     * next model call reads it without an interrupted stream. Reports whether
     * anything joined: an answer written while steering waited is not the
     * turn's last word.
     *
     * The inbox decides *which* items a step may take and when none may be
     * taken at all; this supplies only the transcript write.
     */
    const deliverSteeringAtStepBoundary = (options: { readonly finalStep: boolean }) =>
      scope.inbox.deliverSteering({
        finalStep: options.finalStep,
        // The message joins the transcript now. Its admission time could sort it
        // between a tool call and its result, which the projection rejects.
        //
        // `steering` marks it as answered by the turn it joined. Without the
        // mark it is a user-role message with no `TurnCompleted` of its own,
        // and a restart reads that as an unanswered turn and answers it twice.
        // Only delivery stamps it: an interjection that woke an idle branch
        // never reaches this boundary and must still recover.
        join: (item) =>
          Effect.gen(function* () {
            yield* persistMessageReceived({
              message: {
                ...item.message,
                createdAt: yield* DateTime.nowAsDate,
                metadata: { ...item.message.metadata, customType: "steering" },
              },
            })
          }),
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
      yield* updateTurnRecord(
        params.messageId,
        () => ({ continuations: used + 1 }),
        Option.some(record),
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
      const resolved = yield* resolveForState(params.state, params.turnProfile)
      // `resolveTurnContext` published `ErrorOccurred` and gave up — an unknown
      // agent, most often. The turn produced no answer, so say so rather than
      // publish a `TurnCompleted` no caller can tell from a reply.
      if (Predicate.isUndefined(resolved)) {
        return endStep(params.currentTurnAgent, { unanswered: true })
      }

      const currentTurnAgent = resolved.currentTurnAgent
      const stop = (reason: {
        readonly interrupted?: boolean
        readonly streamFailed?: boolean
        readonly unanswered?: boolean
      }) => endStep(currentTurnAgent, reason)
      const proceed = StepResult.cases.Continue.make({ currentTurnAgent })

      const maxSteps = Math.min(resolved.agent.maxSteps ?? MAX_TURN_STEPS, MAX_TURN_STEPS)
      if (params.step > maxSteps) {
        // Only reachable when the final step said nothing at all: it ran with
        // tools disabled, so it had no way to ask for another. Leaving the
        // flags false publishes a `TurnCompleted` no caller can tell from a
        // reply, and `headless-runner.ts` reads exactly that flag to pick its
        // exit code, so `gent -H` would exit 0 having printed nothing.
        yield* Effect.logWarning("turn.max-steps-exceeded").pipe(
          Effect.annotateLogs({ step: params.step, max: maxSteps }),
        )
        return stop({ unanswered: true })
      }
      // The last step the budget allows. Rather than cut the turn off mid-plan,
      // tell the model its tools are gone and let it spend this step writing
      // the answer. Prior art: opencode-v2 does the same at its ceiling
      // (`runner/llm.ts:221`).
      const finalStep = params.step === maxSteps
      if (finalStep) {
        yield* persistMessageReceived({
          message: Message.cases.regular.make({
            id: finalStepMessageIdForTurn(params.state.message.id),
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            role: "user",
            parts: [Prompt.textPart({ text: MAX_STEPS_INSTRUCTION })],
            createdAt: yield* DateTime.nowAsDate,
            metadata: { customType: "max-steps", details: { step: params.step } },
          }),
        })
        yield* Effect.logWarning("turn.max-steps-final").pipe(
          Effect.annotateLogs({ step: params.step, max: maxSteps }),
        )
      }
      if (params.step === 1) {
        yield* scope.turnLedger.noteModel({ agent: currentTurnAgent, model: resolved.modelId })
      }
      if (yield* scope.turnInterruption.interrupted) {
        return stop({ interrupted: true })
      }

      const attempt = yield* Effect.scoped(
        Effect.gen(function* () {
          const activeStream = yield* makeActiveStreamHandle
          yield* Ref.set(scope.activeStreamRef, Option.some(activeStream))
          return yield* collectTurnStream({
            messageId: params.state.message.id,
            step: params.step,
            finalStep,
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
        const interactionSignal = yield* executeTools({
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
          stepAddress(params.state.message.id, params.step).assistant,
        )
        yield* deliverSteeringAtStepBoundary({ finalStep: false })
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
            if (!empty && !truncated) {
              // Steering that arrived while the answer streamed joins this
              // turn. Left for the next one, it would be answered in a turn
              // whose receipt nobody waits for: a parent hears a child once.
              //
              // Not on the last step of the budget: delivery takes the item
              // off the queue, and with no step left to read it the message
              // would be gone. It stays queued and opens the next turn.
              return deliverSteeringAtStepBoundary({ finalStep }).pipe(
                Effect.map((joined) => {
                  if (joined) return proceed
                  return stop({})
                }),
              )
            }
            let instruction = EMPTY_RESPONSE_INSTRUCTION
            if (truncated) instruction = TRUNCATED_RESPONSE_INSTRUCTION
            return continueOr(instruction, stop({ unanswered: empty }))
          },
          ToolCalls: () => runTools,
        }),
      )(outcome)
    })

    const runTurn = Effect.fn("AgentLoop.runTurn")(function* (state: RunningState) {
      yield* scope.turnLedger.beginTurn
      const cancelled = yield* operations
        .isTurnCancelled({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          messageId: state.message.id,
        })
        .pipe(asAgentLoopError("Cannot read targeted cancellation"))
      if (cancelled) yield* scope.turnInterruption.interrupt

      const turnProfile = yield* scope.resolveTurnProfile

      const provideTurnContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ConfigService, configServiceForRun),
          runAgentLoopTurnProfile(turnProfile),
        )

      let preserveReplayBindings = false
      const turnAgent = state.agentOverride ?? DEFAULT_AGENT_NAME

      /**
       * Run model steps until one says stop, the branch is interrupted, or a
       * tool parks the turn on an interaction.
       *
       * Returns the `Stop` that ends the turn, or the `Interaction` that
       * suspends it. Everything `finalizeTurn` needs already rides on `Stop`,
       * so the loop hands that value up instead of unpacking it into flags.
       */
      const runSteps = Effect.fn("AgentLoop.runSteps")(function* (from: number) {
        let step = from
        let agent = turnAgent
        while (true) {
          step++
          if (yield* scope.turnInterruption.interrupted) {
            return endStep(agent, { interrupted: true })
          }
          const result = yield* runTurnStep({ state, step, currentTurnAgent: agent, turnProfile })
          if (result._tag !== "Continue") return result
          agent = result.currentTurnAgent
        }
      })

      return yield* Effect.gen(function* () {
        yield* persistMessageReceived({ message: state.message })
        yield* scope.inbox.settle(state.message.id)

        const resumed = yield* resumeTurn({
          state,
          messageId: state.message.id,
          interrupted: yield* scope.turnInterruption.interrupted,
          currentTurnAgent: turnAgent,
          turnProfile,
        })
        if (Option.isSome(resumed.interaction)) {
          preserveReplayBindings = true
          return resumed.interaction.value
        }

        const ended = yield* runSteps(resumed.step)
        if (ended._tag === "Interaction") {
          preserveReplayBindings = true
          return ended.outcome
        }

        yield* finalizeTurn({
          startedAtMs: state.startedAtMs,
          messageId: state.message.id,
          turnInterrupted: ended.interrupted,
          streamFailed: ended.streamFailed,
          unanswered: ended.unanswered,
          turnAgent: ended.currentTurnAgent,
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
