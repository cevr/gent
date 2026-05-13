import { Context, DateTime, Effect, Ref, Schema } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"
import {
  AgentName,
  DEFAULT_AGENT_NAME,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { StreamEnded, StreamStarted, TurnCompleted } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { InteractionRequestId, type BranchId, type SessionId } from "../../domain/ids.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import type { PromptSection } from "../../domain/prompt.js"
import { MessageStorage } from "../../storage/message-storage.js"
import { makeStorageTransaction } from "../../storage/sqlite-storage.js"
import { ConfigService } from "../config-service.js"
import { DriverRegistry, type DriverRegistryService } from "../extensions/driver-registry.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { WideEvent } from "../wide-event-boundary.js"
import type { AgentLoopError, QueuedTurnItem, RunningState } from "./agent-loop.state.js"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"
import {
  collectExternalTurnResponse,
  collectModelTurnResponse,
  emptyTurnMetrics,
  makeActiveStreamHandle,
  type ActiveStreamHandle,
  type TurnMetrics,
} from "./turn-response.js"
import {
  findPersistedEvent,
  persistAssistantParts,
  persistMessageReceived,
  persistToolParts,
  type AssistantResponsePart,
  type ToolResponsePart,
} from "./turn-persistence.js"
import { computeStreamEndedCost } from "./turn-pricing.js"
import { resolveTurnContext, type ResolvedTurnContext } from "./turn-resolve.js"
import { resolveTurnSource, toolCallsFromResponseParts } from "./turn-source.js"
import { executeToolCalls, ToolInteractionPending } from "./turn-tool-execution.js"
import {
  CurrentExtensionHostContext,
  provideCurrentHostCtx,
} from "./current-extension-host-context.js"

const MAX_TURN_STEPS = 200

export const TurnOutcome = Schema.TaggedUnion({
  Done: {},
  InteractionRequested: {
    pendingRequestId: InteractionRequestId,
    pendingToolCallId: Schema.String,
    currentTurnAgent: AgentName,
  },
})
export type TurnOutcome = Schema.Schema.Type<typeof TurnOutcome>

export type AgentLoopTurnProfile = {
  readonly turnExtensionRegistry: ExtensionRegistryService
  readonly turnDriverRegistry: DriverRegistryService
  readonly turnPermission: PermissionService
  readonly turnBaseSections: ReadonlyArray<PromptSection>
  readonly turnHostCtx: ExtensionHostContext
}

export type AgentLoopTurnExecutionScopeService = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly resolveTurnProfile: Effect.Effect<AgentLoopTurnProfile>
  readonly activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  readonly turnMetricsRef: Ref.Ref<TurnMetrics>
  readonly interruptedRef: Ref.Ref<boolean>
  readonly clearInFlightTurn: (
    messageId: QueuedTurnItem["message"]["id"],
  ) => Effect.Effect<void, AgentLoopError>
}

export class AgentLoopTurnExecutionScope extends Context.Service<
  AgentLoopTurnExecutionScope,
  AgentLoopTurnExecutionScopeService
>()("@gent/core/src/runtime/agent/agent-loop.turn-execution/AgentLoopTurnExecutionScope") {}

export const makeAgentLoopTurnExecution = Effect.gen(function* () {
  const scope = yield* AgentLoopTurnExecutionScope
  const messageStorage = yield* MessageStorage
  const eventPublisher = yield* EventPublisher
  const storageTransaction = yield* makeStorageTransaction
  const configServiceForRun = yield* ConfigService

  const executeTools = Effect.fn("AgentLoop.executeTools")(function* (params: {
    messageId: RunningState["message"]["id"]
    step: number
    toolCalls: ReadonlyArray<Prompt.ToolCallPart>
    currentTurnAgent: AgentNameType
  }) {
    if (params.toolCalls.length === 0) return

    const toolResultMessageId = toolResultMessageIdForTurn(params.messageId, params.step)
    const existing = yield* messageStorage.getMessage(toolResultMessageId)
    if (existing !== undefined) return

    const toolResults = yield* executeToolCalls({
      toolCalls: params.toolCalls,
      sessionId: scope.sessionId,
      branchId: scope.branchId,
      currentTurnAgent: params.currentTurnAgent,
    })
    yield* persistToolParts({
      sessionId: scope.sessionId,
      branchId: scope.branchId,
      messageId: toolResultMessageId,
      parts: toolResults,
    })
  })

  const collectTurnStream = Effect.fn("AgentLoop.collectTurnStream")(function* (params: {
    messageId: RunningState["message"]["id"]
    step: number
    resolved: ResolvedTurnContext
    activeStream: ActiveStreamHandle
  }) {
    const persistAssistantPartsLocal = (
      parts: ReadonlyArray<AssistantResponsePart>,
      createdAt?: Date,
    ) =>
      persistAssistantParts({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        messageId: assistantMessageIdForTurn(params.messageId, params.step),
        parts,
        createdAt,
        agentName: params.resolved.currentTurnAgent,
      })

    const persistToolPartsLocal = (parts: ReadonlyArray<ToolResponsePart>, createdAt?: Date) =>
      persistToolParts({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        messageId: toolResultMessageIdForTurn(params.messageId, params.step),
        parts,
        createdAt,
      })

    const source = yield* resolveTurnSource({
      resolved: params.resolved,
      sessionId: scope.sessionId,
      branchId: scope.branchId,
      activeStream: params.activeStream,
    })

    if (source === undefined) {
      return {
        responseParts: [],
        messageProjection: { assistant: [], tool: [] },
        interrupted: false,
        streamFailed: true,
        driverKind: params.resolved.driver?._tag === "external" ? "external" : "model",
      }
    }

    const eventPublisher = yield* EventPublisher
    const publishEventOrDie = (event: StreamStarted | StreamEnded) =>
      eventPublisher.publish(event).pipe(Effect.orDie)

    yield* publishEventOrDie(
      StreamStarted.make({ sessionId: scope.sessionId, branchId: scope.branchId }),
    )

    yield* Effect.logInfo("turn-stream.start").pipe(
      Effect.annotateLogs({
        agent: params.resolved.currentTurnAgent,
        driverKind: source.driverKind,
        model: params.resolved.modelId,
        ...(source.driverId !== undefined ? { driverId: source.driverId } : {}),
      }),
    )

    const collected =
      source.driverKind === "model"
        ? yield* source.collect(
            collectModelTurnResponse({
              turnStream: source.stream,
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              modelId: params.resolved.modelId,
              activeStream: params.activeStream,
              formatStreamError: source.formatStreamError,
              retryPreOutputFailures: true,
            }),
          )
        : yield* source.collect(
            collectExternalTurnResponse({
              turnStream: source.stream,
              sessionId: scope.sessionId,
              branchId: scope.branchId,
              activeStream: params.activeStream,
              formatStreamError: source.formatStreamError,
            }),
          )

    if (collected.interrupted) {
      yield* publishEventOrDie(
        StreamEnded.make({
          sessionId: scope.sessionId,
          branchId: scope.branchId,
          interrupted: true,
        }),
      )
      yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
      return collected
    }

    if (collected.streamFailed) {
      yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
      yield* persistToolPartsLocal(collected.messageProjection.tool)
      return collected
    }

    const streamEndedCost = yield* computeStreamEndedCost({
      modelId: params.resolved.modelId,
      usage: collected.messageProjection.usage,
    })
    yield* publishEventOrDie(
      StreamEnded.make({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        ...(collected.messageProjection.usage !== undefined
          ? { usage: collected.messageProjection.usage }
          : {}),
        model: params.resolved.modelId,
        ...(streamEndedCost !== undefined ? { costUsd: streamEndedCost } : {}),
      }),
    )
    yield* Effect.logInfo("stream.end").pipe(
      Effect.annotateLogs({
        driverKind: source.driverKind,
        inputTokens: collected.messageProjection.usage?.inputTokens ?? 0,
        outputTokens: collected.messageProjection.usage?.outputTokens ?? 0,
        toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
      }),
    )

    yield* Ref.update(scope.turnMetricsRef, (m) => ({
      ...m,
      agent: params.resolved.currentTurnAgent,
      model: params.resolved.modelId,
      inputTokens: m.inputTokens + (collected.messageProjection.usage?.inputTokens ?? 0),
      outputTokens: m.outputTokens + (collected.messageProjection.usage?.outputTokens ?? 0),
      toolCallCount: m.toolCallCount + toolCallsFromResponseParts(collected.responseParts).length,
    }))

    yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
    yield* persistToolPartsLocal(collected.messageProjection.tool)

    return collected
  })

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
    if (existingMessage?.turnDurationMs !== undefined) {
      const envelope = yield* findPersistedEvent({
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        match: (candidate) =>
          candidate.event._tag === "TurnCompleted" &&
          candidate.event.messageId === params.messageId,
      })
      if (envelope !== undefined) {
        yield* eventPublisher.deliver(envelope)
      }
      return
    }

    const turnEndTime = yield* DateTime.now
    const turnDurationMs = DateTime.toEpochMillis(turnEndTime) - params.startedAtMs

    const envelope = yield* storageTransaction(
      Effect.gen(function* () {
        yield* messageStorage.updateMessageTurnDuration(params.messageId, turnDurationMs)
        return yield* eventPublisher.append(
          TurnCompleted.make({
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            messageId: params.messageId,
            durationMs: Number(turnDurationMs),
            ...(params.turnInterrupted ? { interrupted: true } : {}),
          }),
        )
      }),
    )
    yield* eventPublisher.deliver(envelope)

    yield* Effect.logDebug("finalize.turn-after.start")
    yield* extensionRegistry.extensionReactions.emitTurnAfter(
      {
        sessionId: scope.sessionId,
        branchId: scope.branchId,
        durationMs: Number(turnDurationMs),
        agentName: params.currentAgent,
        interrupted: params.turnInterrupted,
      },
      hostCtx,
    )
    yield* Effect.logDebug("finalize.turn-after.done")

    yield* Effect.logInfo("turn.completed").pipe(
      Effect.annotateLogs({
        durationMs: Number(turnDurationMs),
        interrupted: params.turnInterrupted,
      }),
    )

    const metrics = yield* Ref.get(scope.turnMetricsRef)
    yield* WideEvent.set({
      actor: metrics.agent,
      model: metrics.model,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      toolCallCount: metrics.toolCallCount,
      interrupted: params.turnInterrupted,
      ...(params.streamFailed && !params.turnInterrupted ? { streamFailed: true } : {}),
    })
  })

  const runTurn = Effect.fn("AgentLoop.runTurn")(function* (state: RunningState) {
    yield* Ref.set(scope.turnMetricsRef, emptyTurnMetrics())

    const {
      turnExtensionRegistry,
      turnDriverRegistry,
      turnPermission,
      turnBaseSections,
      turnHostCtx,
    } = yield* scope.resolveTurnProfile

    const provideTurnContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(ExtensionRegistry, turnExtensionRegistry),
        Effect.provideService(DriverRegistry, turnDriverRegistry),
        Effect.provideService(Permission, turnPermission),
        Effect.provideService(ConfigService, configServiceForRun),
        provideCurrentHostCtx(turnHostCtx),
      )

    return yield* Effect.gen(function* () {
      let step = 0
      let interrupted = yield* Ref.get(scope.interruptedRef)
      let streamFailed = false
      let currentTurnAgent: AgentNameType = state.currentAgent ?? DEFAULT_AGENT_NAME

      const resumeStep = 1
      const existingAssistant = yield* messageStorage
        .getMessage(assistantMessageIdForTurn(state.message.id, resumeStep))
        .pipe(Effect.orElseSucceed(() => undefined))
      if (existingAssistant !== undefined && !interrupted) {
        const toolCalls = assistantDraftFromMessage(existingAssistant).toolCalls
        if (toolCalls.length > 0) {
          const existingResults = yield* messageStorage
            .getMessage(toolResultMessageIdForTurn(state.message.id, resumeStep))
            .pipe(Effect.orElseSucceed(() => undefined))
          if (existingResults === undefined) {
            yield* Effect.logInfo("turn.resume-tools")
            const interactionSignal = yield* executeTools({
              messageId: state.message.id,
              step: resumeStep,
              toolCalls,
              currentTurnAgent,
            }).pipe(
              Effect.as(undefined as ToolInteractionPending | undefined),
              Effect.catchIf(Schema.is(ToolInteractionPending), (e) => Effect.succeed(e)),
            )

            if (interactionSignal !== undefined) {
              const { pending, toolCallId } = interactionSignal
              return TurnOutcome.cases.InteractionRequested.make({
                pendingRequestId: pending.requestId,
                pendingToolCallId: toolCallId as string,
                currentTurnAgent,
              })
            }
            step = 1
          }
        }
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

        yield* persistMessageReceived({ message: state.message })
        yield* scope.clearInFlightTurn(state.message.id)

        const resolved = yield* resolveTurnContext({
          agentOverride: state.agentOverride,
          runSpec: state.runSpec,
          currentAgent: state.currentAgent,
          branchId: scope.branchId,
          sessionId: scope.sessionId,
          baseSections: turnBaseSections,
          interactive: state.interactive,
        })
        if (resolved === undefined) break

        currentTurnAgent = resolved.currentTurnAgent
        if (step === 1) {
          yield* Ref.update(scope.turnMetricsRef, (m) => ({
            ...m,
            agent: resolved.currentTurnAgent,
            model: resolved.modelId,
          }))
        }

        if (yield* Ref.get(scope.interruptedRef)) {
          interrupted = true
          break
        }

        const collected = yield* Effect.scoped(
          Effect.gen(function* () {
            const activeStream = yield* makeActiveStreamHandle()
            yield* Ref.set(scope.activeStreamRef, activeStream)
            return yield* collectTurnStream({
              messageId: state.message.id,
              step,
              resolved,
              activeStream,
            })
          }).pipe(Effect.ensuring(Ref.set(scope.activeStreamRef, undefined))),
        )

        if (collected.interrupted) {
          interrupted = true
          break
        }
        if (collected.streamFailed) {
          streamFailed = true
          break
        }

        if (collected.driverKind === "external") break

        const toolCalls = toolCallsFromResponseParts(collected.responseParts)
        if (toolCalls.length === 0) break

        const interactionSignal = yield* executeTools({
          messageId: state.message.id,
          step,
          toolCalls,
          currentTurnAgent: resolved.currentTurnAgent,
        }).pipe(
          Effect.as(undefined as ToolInteractionPending | undefined),
          Effect.catchIf(Schema.is(ToolInteractionPending), (e) => Effect.succeed(e)),
        )

        if (interactionSignal !== undefined) {
          const { pending, toolCallId } = interactionSignal
          return TurnOutcome.cases.InteractionRequested.make({
            pendingRequestId: pending.requestId,
            pendingToolCallId: toolCallId as string,
            currentTurnAgent: resolved.currentTurnAgent,
          })
        }
      }

      yield* finalizeTurn({
        startedAtMs: state.startedAtMs,
        messageId: state.message.id,
        turnInterrupted: interrupted,
        streamFailed,
        currentAgent: currentTurnAgent,
      })

      return TurnOutcome.cases.Done.make({})
    }).pipe(provideTurnContext)
  })

  return { runTurn }
})
