import {
  Cause,
  ServiceMap,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect"
import {
  type AnyInspectionEvent,
  combineInspectors,
  Event,
  InspectorService,
  Machine,
  State,
  makeInspectorEffect,
  tracingInspector,
} from "effect-machine"
import {
  AgentDefinition,
  AgentName,
  ReasoningEffort,
  resolveAgentModel,
  SubagentError,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import type { ModelId } from "../../domain/model.js"
import { type QueueSnapshot } from "../../domain/queue.js"
import {
  EventStore,
  AgentSwitched,
  StreamStarted,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  ToolCallStarted,
  ToolCallSucceeded,
  ToolCallFailed,
  MessageReceived,
  ErrorOccurred,
  ProviderRetrying,
  TurnRecoveryApplied,
  MachineInspected,
  MachineTaskFailed,
  MachineTaskSucceeded,
  type AgentEvent,
} from "../../domain/event.js"
import { Message, TextPart, ReasoningPart, ToolCallPart } from "../../domain/message.js"
import { SessionId, BranchId, type MessageId } from "../../domain/ids.js"
import { type ToolAction, type ToolContext } from "../../domain/tool.js"
import { HandoffHandler } from "../../domain/interaction-handlers.js"
import { DEFAULTS } from "../../domain/defaults.js"
import { Storage, type StorageError, type StorageService } from "../../storage/sqlite-storage.js"
import { Provider, type FinishChunk } from "../../providers/provider.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import { withRetry } from "../retry"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { ToolRunner } from "./tool-runner"
import {
  type ActiveStreamHandle,
  executeToolsPhase,
  finalizeTurnPhase,
  resolveTurnPhase,
  streamTurnPhase,
} from "./agent-loop-phases.js"
import {
  AGENT_LOOP_CHECKPOINT_VERSION,
  buildLoopCheckpointRecord,
  decodeLoopCheckpointState,
  shouldRetainLoopCheckpoint,
  type AgentLoopCheckpointRecord,
} from "./agent-loop.checkpoint.js"
import {
  AgentLoopEvent,
  AgentLoopState,
  appendFollowUpQueueState,
  appendSteeringItem,
  buildIdleState,
  buildResolvingState,
  clearQueueState,
  countQueuedFollowUps,
  markInterruptAfterTools,
  markTurnInterrupted,
  queueContainsContent,
  queueSnapshotFromState,
  runtimeStateFromLoopState,
  takeNextQueuedTurn,
  toExecutingToolsState,
  toFinalizingState,
  toStreamingState,
  updateCurrentAgentOnState,
  updateQueueOnState,
  type ExecutingToolsState,
  type FinalizingState,
  type IdleState,
  type LoopActor,
  type LoopState,
  type QueuedTurnItem,
  type ResolvingState,
  type StreamingState,
} from "./agent-loop.state.js"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  buildSystemPrompt,
  messageText,
  resolveReasoning,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"

// Agent Loop Error

export class AgentLoopError extends Schema.TaggedErrorClass<AgentLoopError>()("AgentLoopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// Steer Command

const SteerTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

export const SteerCommand = Schema.Union([
  Schema.TaggedStruct("Cancel", SteerTargetFields),
  Schema.TaggedStruct("Interrupt", SteerTargetFields),
  Schema.TaggedStruct("Interject", {
    ...SteerTargetFields,
    message: Schema.String,
    agent: Schema.optional(AgentName),
  }),
  Schema.TaggedStruct("SwitchAgent", { ...SteerTargetFields, agent: AgentName }),
])
export type SteerCommand = typeof SteerCommand.Type

// Agent Loop Context

const resolveStoredAgent = (params: {
  storage: StorageService
  sessionId: SessionId
  branchId: BranchId
}): Effect.Effect<AgentNameType, never> =>
  Effect.gen(function* () {
    const latestAgentEvent = yield* params.storage
      .getLatestEvent({
        sessionId: params.sessionId,
        branchId: params.branchId,
        tags: ["AgentSwitched"],
      })
      .pipe(Effect.catchEager(() => Effect.void))

    const raw =
      latestAgentEvent !== undefined && latestAgentEvent._tag === "AgentSwitched"
        ? latestAgentEvent.toAgent
        : undefined

    return Schema.is(AgentName)(raw) ? raw : "cowork"
  })

const applyAgentOverrides = (agent: AgentDefinition, input: AgentRunInput): AgentDefinition => {
  if (
    input.overrideAllowedActions === undefined &&
    input.overrideAllowedTools === undefined &&
    input.overrideDeniedTools === undefined &&
    input.overrideReasoningEffort === undefined &&
    input.overrideSystemPromptAddendum === undefined
  ) {
    return agent
  }

  return new AgentDefinition({
    ...agent,
    ...(input.overrideAllowedActions !== undefined
      ? {
          allowedActions: input.overrideAllowedActions as ReadonlyArray<ToolAction>,
        }
      : {}),
    ...(input.overrideAllowedTools !== undefined
      ? { allowedTools: input.overrideAllowedTools }
      : {}),
    ...(input.overrideDeniedTools !== undefined ? { deniedTools: input.overrideDeniedTools } : {}),
    ...(input.overrideReasoningEffort !== undefined
      ? { reasoningEffort: input.overrideReasoningEffort }
      : {}),
    ...(input.overrideSystemPromptAddendum !== undefined
      ? {
          systemPromptAddendum:
            agent.systemPromptAddendum !== undefined
              ? `${agent.systemPromptAddendum}\n\n${input.overrideSystemPromptAddendum}`
              : input.overrideSystemPromptAddendum,
        }
      : {}),
  })
}

type SemaphoreType = Semaphore.Semaphore

type LoopHandle = {
  actor: LoopActor
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  bashSemaphore: SemaphoreType
  scope: Scope.Closeable
}

const interruptActiveStream = (activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>) =>
  Effect.gen(function* () {
    const activeStream = yield* Ref.get(activeStreamRef)
    if (activeStream === undefined) return
    yield* Ref.set(activeStream.interruptedRef, true)
    yield* Deferred.succeed(activeStream.interruptDeferred, undefined).pipe(Effect.ignore)
    activeStream.abortController.abort()
  })

const publishPhaseFailure = (params: {
  publishEvent: (event: AgentEvent) => Effect.Effect<void, AgentLoopError>
  sessionId: SessionId
  branchId: BranchId
  cause: Cause.Cause<unknown>
}) =>
  params
    .publishEvent(
      new ErrorOccurred({
        sessionId: params.sessionId,
        branchId: params.branchId,
        error: Cause.pretty(params.cause),
      }),
    )
    .pipe(
      Effect.catchEager((error) => Effect.logWarning("failed to publish ErrorOccurred", error)),
      Effect.asVoid,
    )

const makePublishingInspector = (params: {
  publishEvent: (event: AgentEvent) => Effect.Effect<void, never>
  sessionId: SessionId
  branchId: BranchId
}) =>
  combineInspectors(
    tracingInspector<{ readonly _tag: string }, { readonly _tag: string }>({
      attributes: () => ({
        sessionId: params.sessionId,
        branchId: params.branchId,
      }),
    }),
    makeInspectorEffect<{ readonly _tag: string }, { readonly _tag: string }>(
      (event: AnyInspectionEvent) =>
        params
          .publishEvent(
            new MachineInspected({
              sessionId: params.sessionId,
              branchId: params.branchId,
              actorId: event.actorId,
              inspectionType: event.type,
              payload: event,
            }),
          )
          .pipe(
            Effect.withSpan("Machine.inspect.publish"),
            Effect.catchEager((error) =>
              Effect.logWarning("failed to publish MachineInspected", error),
            ),
          ),
    ),
  )

const persistLoopCheckpoint = (params: {
  storage: StorageService
  sessionId: SessionId
  branchId: BranchId
  state: LoopState
}) =>
  Effect.gen(function* () {
    if (!shouldRetainLoopCheckpoint(params.state)) {
      yield* params.storage.deleteAgentLoopCheckpoint({
        sessionId: params.sessionId,
        branchId: params.branchId,
      })
      return
    }

    const record = yield* buildLoopCheckpointRecord(params)
    yield* params.storage.upsertAgentLoopCheckpoint(record)
  })

const makeCheckpointInspector = (params: {
  storage: StorageService
  sessionId: SessionId
  branchId: BranchId
}) =>
  makeInspectorEffect<{ readonly _tag: string }, { readonly _tag: string }>((event) => {
    switch (event.type) {
      case "@machine.spawn":
        return persistLoopCheckpoint({
          storage: params.storage,
          sessionId: params.sessionId,
          branchId: params.branchId,
          state: event.initialState as LoopState,
        }).pipe(
          Effect.catchEager((error) =>
            Effect.logWarning("failed to persist loop checkpoint", error),
          ),
        )
      case "@machine.transition":
        return persistLoopCheckpoint({
          storage: params.storage,
          sessionId: params.sessionId,
          branchId: params.branchId,
          state: event.toState as LoopState,
        }).pipe(
          Effect.catchEager((error) =>
            Effect.logWarning("failed to persist loop checkpoint", error),
          ),
        )
      case "@machine.stop":
        return persistLoopCheckpoint({
          storage: params.storage,
          sessionId: params.sessionId,
          branchId: params.branchId,
          state: event.finalState as LoopState,
        }).pipe(
          Effect.catchEager((error) =>
            Effect.logWarning("failed to persist loop checkpoint", error),
          ),
        )
      default:
        return Effect.void
    }
  })

type LoopRecoveryDecision = {
  state: LoopState
  recovery?: {
    phase: "Idle" | "Resolving" | "Streaming" | "ExecutingTools" | "Finalizing"
    action:
      | "resume-queued-turn"
      | "replay-resolving"
      | "replay-streaming"
      | "reuse-persisted-assistant"
      | "replay-idempotent-tools"
      | "reuse-persisted-tool-results"
      | "abort-non-idempotent-tools"
      | "replay-finalizing"
    detail?: string
  }
}

const restoreCheckpointState = (params: {
  checkpoint: AgentLoopCheckpointRecord
  storage: StorageService
  extensionRegistry: ExtensionRegistryService
  currentAgent: AgentNameType
}): Effect.Effect<LoopRecoveryDecision | undefined, StorageError> =>
  Effect.gen(function* () {
    if (params.checkpoint.version !== AGENT_LOOP_CHECKPOINT_VERSION) {
      yield* params.storage.deleteAgentLoopCheckpoint({
        sessionId: params.checkpoint.sessionId,
        branchId: params.checkpoint.branchId,
      })
      return undefined
    }

    const state = Option.getOrUndefined(
      yield* Effect.option(decodeLoopCheckpointState(params.checkpoint.stateJson)),
    )
    if (state === undefined) {
      yield* params.storage.deleteAgentLoopCheckpoint({
        sessionId: params.checkpoint.sessionId,
        branchId: params.checkpoint.branchId,
      })
      return undefined
    }

    if (state._tag === "Idle") {
      const { queue, nextItem } = takeNextQueuedTurn(state.queue)
      if (nextItem !== undefined) {
        return {
          state: buildResolvingState(
            {
              queue,
              currentAgent: state.currentAgent ?? params.currentAgent,
              handoffSuppress: state.handoffSuppress,
            },
            nextItem,
          ),
          recovery: {
            phase: "Idle",
            action: "resume-queued-turn",
          },
        }
      }
      return {
        state:
          state.currentAgent === undefined
            ? updateCurrentAgentOnState(state, params.currentAgent)
            : state,
      }
    }

    if (state._tag === "Resolving") {
      return {
        state,
        recovery: {
          phase: "Resolving",
          action: "replay-resolving",
        },
      }
    }

    if (state._tag === "Streaming") {
      const assistantMessage = yield* params.storage.getMessage(
        assistantMessageIdForTurn(state.message.id),
      )
      if (assistantMessage !== undefined) {
        const draft = assistantDraftFromMessage(assistantMessage)
        return {
          state:
            draft.toolCalls.length === 0
              ? toFinalizingState({
                  state,
                  currentTurnAgent: state.currentTurnAgent,
                  streamFailed: false,
                  turnInterrupted: state.turnInterrupted,
                })
              : toExecutingToolsState({
                  state,
                  currentTurnAgent: state.currentTurnAgent,
                  draft,
                }),
          recovery: {
            phase: "Streaming",
            action: "reuse-persisted-assistant",
          },
        }
      }
      return {
        state,
        recovery: {
          phase: "Streaming",
          action: "replay-streaming",
        },
      }
    }

    if (state._tag === "ExecutingTools") {
      const toolResultMessage = yield* params.storage.getMessage(
        toolResultMessageIdForTurn(state.message.id),
      )
      if (toolResultMessage !== undefined) {
        return {
          state: toFinalizingState({
            state,
            currentTurnAgent: state.currentTurnAgent,
            usage: state.draft.usage,
            streamFailed: false,
            turnInterrupted: state.turnInterrupted || state.interruptAfterTools,
          }),
          recovery: {
            phase: "ExecutingTools",
            action: "reuse-persisted-tool-results",
          },
        }
      }

      const canReplay = yield* Effect.forEach(
        state.draft.toolCalls,
        (toolCall) =>
          params.extensionRegistry
            .getTool(toolCall.toolName)
            .pipe(Effect.map((tool) => tool?.idempotent === true)),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((results) => results.every(Boolean)))

      if (canReplay) {
        return {
          state,
          recovery: {
            phase: "ExecutingTools",
            action: "replay-idempotent-tools",
          },
        }
      }

      return {
        state: toFinalizingState({
          state,
          currentTurnAgent: state.currentTurnAgent,
          usage: state.draft.usage,
          streamFailed: true,
          turnInterrupted: true,
        }),
        recovery: {
          phase: "ExecutingTools",
          action: "abort-non-idempotent-tools",
          detail: "Skipped replay for non-idempotent tool calls after crash",
        },
      }
    }

    return {
      state,
      recovery: {
        phase: "Finalizing",
        action: "replay-finalizing",
      },
    }
  })

// Agent Loop Service

export interface AgentLoopService {
  readonly submit: (
    message: Message,
    options?: { bypass?: boolean },
  ) => Effect.Effect<void, AgentLoopError>
  readonly run: (
    message: Message,
    options?: { bypass?: boolean },
  ) => Effect.Effect<void, AgentLoopError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void>
  readonly followUp: (message: Message) => Effect.Effect<void, AgentLoopError>
  readonly drainQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot>
  readonly getQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot>
  readonly isRunning: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<boolean>
  readonly getState: (input: { sessionId: SessionId; branchId: BranchId }) => Effect.Effect<{
    status: "idle" | "running" | "interrupted"
    agent: AgentNameType
    queueDepth: number
  }>
}

export class AgentLoop extends ServiceMap.Service<AgentLoop, AgentLoopService>()(
  "@gent/core/src/runtime/agent/agent-loop/AgentLoop",
) {
  static Live = (config: {
    systemPrompt: string
  }): Layer.Layer<
    AgentLoop,
    never,
    Storage | Provider | ExtensionRegistry | EventStore | HandoffHandler | ToolRunner
  > =>
    Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const storage = yield* Storage
        const provider = yield* Provider
        const extensionRegistry = yield* ExtensionRegistry
        const eventStore = yield* EventStore
        const handoffHandler = yield* HandoffHandler
        const toolRunner = yield* ToolRunner
        const loopsRef = yield* Ref.make<Map<string, LoopHandle>>(new Map())
        const loopsSemaphore = yield* Semaphore.make(1)

        const stateKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`
        const publishEvent = (event: AgentEvent) =>
          eventStore.publish(event).pipe(
            Effect.mapError(
              (error) =>
                new AgentLoopError({
                  message: `Failed to publish ${event._tag}`,
                  cause: error,
                }),
            ),
          )
        const publishEventOrDie = (event: AgentEvent) => publishEvent(event).pipe(Effect.orDie)

        const makeLoop = (sessionId: SessionId, branchId: BranchId) =>
          Effect.gen(function* () {
            const loopScope = yield* Scope.make()
            const bashSemaphore = yield* Semaphore.make(1)
            const activeStreamRef = yield* Ref.make<ActiveStreamHandle | undefined>(undefined)
            const currentAgent = yield* resolveStoredAgent({ storage, sessionId, branchId })
            const checkpoint = Option.getOrUndefined(
              yield* Effect.option(storage.getAgentLoopCheckpoint({ sessionId, branchId })),
            )
            const restored = Option.getOrUndefined(
              yield* checkpoint === undefined
                ? Effect.succeed(Option.none<LoopRecoveryDecision>())
                : Effect.option(
                    restoreCheckpointState({
                      checkpoint,
                      storage,
                      extensionRegistry,
                      currentAgent,
                    }),
                  ),
            )
            const initialState = restored?.state ?? buildIdleState({ currentAgent })
            const inspector = combineInspectors(
              makePublishingInspector({
                publishEvent: publishEventOrDie,
                sessionId,
                branchId,
              }),
              makeCheckpointInspector({
                storage,
                sessionId,
                branchId,
              }),
            )

            if (restored?.recovery !== undefined) {
              yield* publishEventOrDie(
                new TurnRecoveryApplied({
                  sessionId,
                  branchId,
                  phase: restored.recovery.phase,
                  action: restored.recovery.action,
                  ...(restored.recovery.detail !== undefined
                    ? { detail: restored.recovery.detail }
                    : {}),
                }),
              )
              if (restored.recovery.action === "abort-non-idempotent-tools") {
                yield* publishEventOrDie(
                  new ErrorOccurred({
                    sessionId,
                    branchId,
                    error: restored.recovery.detail ?? "Skipped ambiguous tool replay after crash",
                  }),
                )
              }
            }

            function switchAgentOnState(
              state: IdleState,
              next: AgentNameType,
            ): Effect.Effect<IdleState>
            function switchAgentOnState(
              state: ResolvingState,
              next: AgentNameType,
            ): Effect.Effect<ResolvingState>
            function switchAgentOnState(
              state: StreamingState,
              next: AgentNameType,
            ): Effect.Effect<StreamingState>
            function switchAgentOnState(
              state: ExecutingToolsState,
              next: AgentNameType,
            ): Effect.Effect<ExecutingToolsState>
            function switchAgentOnState(
              state: FinalizingState,
              next: AgentNameType,
            ): Effect.Effect<FinalizingState>
            function switchAgentOnState(
              state: LoopState,
              next: AgentNameType,
            ): Effect.Effect<LoopState>
            function switchAgentOnState(state: LoopState, next: AgentNameType) {
              return Effect.gen(function* () {
                const previous = state.currentAgent ?? "cowork"
                if (previous === next) return state
                const resolved = yield* extensionRegistry.getAgent(next)
                if (resolved === undefined) return state

                yield* publishEvent(
                  new AgentSwitched({
                    sessionId,
                    branchId,
                    fromAgent: previous,
                    toAgent: next,
                  }),
                ).pipe(
                  Effect.catchEager((error) =>
                    Effect.logWarning("failed to publish AgentSwitched", error),
                  ),
                )

                return updateCurrentAgentOnState(state, next)
              }).pipe(Effect.orDie)
            }

            const runResolvingState = Effect.fn("AgentLoop.runResolvingState")(function* (
              state: ResolvingState,
            ) {
              const resolved = yield* resolveTurnPhase({
                message: state.message,
                agentOverride: state.agentOverride,
                currentAgent: state.currentAgent,
                storage,
                branchId,
                extensionRegistry,
                sessionId,
                publishEvent: publishEventOrDie,
                systemPrompt: config.systemPrompt,
              })
              if (resolved === undefined) {
                return AgentLoopEvent.PhaseFailed
              }

              return AgentLoopEvent.Resolved(resolved)
            })

            const runStreamingState = Effect.fn("AgentLoop.runStreamingState")(function* (
              state: StreamingState,
            ) {
              const activeStream: ActiveStreamHandle = {
                abortController: new AbortController(),
                interruptDeferred: yield* Deferred.make<void>(),
                interruptedRef: yield* Ref.make(false),
              }

              yield* Ref.set(activeStreamRef, activeStream)
              const collected = yield* streamTurnPhase({
                messageId: state.message.id,
                resolved: {
                  currentTurnAgent: state.currentTurnAgent,
                  messages: state.messages,
                  systemPrompt: state.systemPrompt,
                  modelId: state.modelId,
                  ...(state.reasoning !== undefined ? { reasoning: state.reasoning } : {}),
                  ...(state.temperature !== undefined ? { temperature: state.temperature } : {}),
                },
                provider,
                extensionRegistry,
                publishEvent: publishEventOrDie,
                storage,
                sessionId,
                branchId,
                activeStream,
              }).pipe(Effect.ensuring(Ref.set(activeStreamRef, undefined)))

              if (collected.interrupted) {
                return AgentLoopEvent.StreamInterrupted({
                  currentTurnAgent: state.currentTurnAgent,
                })
              }

              if (collected.streamFailed) {
                return AgentLoopEvent.StreamFailed({
                  currentTurnAgent: state.currentTurnAgent,
                })
              }

              return AgentLoopEvent.StreamFinished({
                currentTurnAgent: state.currentTurnAgent,
                draft: collected.draft,
              })
            })

            const runExecutingToolsState = Effect.fn("AgentLoop.runExecutingToolsState")(function* (
              state: ExecutingToolsState,
            ) {
              yield* executeToolsPhase({
                messageId: state.message.id,
                draft: state.draft,
                publishEvent: publishEventOrDie,
                sessionId,
                branchId,
                currentTurnAgent: state.currentTurnAgent,
                bypass: state.bypass,
                toolRunner,
                extensionRegistry,
                bashSemaphore,
                storage,
              })
              return AgentLoopEvent.ToolsFinished
            })

            const runFinalizingState = Effect.fn("AgentLoop.runFinalizingState")(function* (
              state: FinalizingState,
            ) {
              const nextHandoffSuppress = yield* finalizeTurnPhase({
                storage,
                publishEvent: publishEventOrDie,
                sessionId,
                branchId,
                startedAtMs: state.startedAtMs,
                messageId: state.message.id,
                turnInterrupted: state.turnInterrupted,
                handoffSuppress: state.handoffSuppress,
                currentAgent: state.currentAgent ?? state.currentTurnAgent ?? "cowork",
                extensionRegistry,
                handoffHandler,
              })

              const { queue, nextItem } = takeNextQueuedTurn(state.queue)
              return AgentLoopEvent.FinalizeFinished({
                queue,
                nextItem,
                handoffSuppress: nextHandoffSuppress,
              })
            })

            const loopMachine = Machine.make({
              state: AgentLoopState,
              event: AgentLoopEvent,
              initial: initialState,
            })
              .on(AgentLoopState.Idle, AgentLoopEvent.Start, ({ state, event }) =>
                buildResolvingState(state, event.item),
              )
              .on(
                [
                  AgentLoopState.Idle,
                  AgentLoopState.Resolving,
                  AgentLoopState.Streaming,
                  AgentLoopState.ExecutingTools,
                  AgentLoopState.Finalizing,
                ],
                AgentLoopEvent.QueueFollowUp,
                ({ state, event }) =>
                  updateQueueOnState(state, appendFollowUpQueueState(state.queue, event.item)),
              )
              .on(
                [
                  AgentLoopState.Idle,
                  AgentLoopState.Resolving,
                  AgentLoopState.Streaming,
                  AgentLoopState.ExecutingTools,
                  AgentLoopState.Finalizing,
                ],
                AgentLoopEvent.ClearQueue,
                ({ state }) => updateQueueOnState(state, clearQueueState(state.queue)),
              )
              .on(
                [
                  AgentLoopState.Idle,
                  AgentLoopState.Resolving,
                  AgentLoopState.Streaming,
                  AgentLoopState.ExecutingTools,
                  AgentLoopState.Finalizing,
                ],
                AgentLoopEvent.SwitchAgent,
                ({ state, event }) => switchAgentOnState(state, event.agent),
              )
              .on(AgentLoopState.Idle, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                updateQueueOnState(state, appendSteeringItem(state.queue, event.item)),
              )
              .on(AgentLoopState.Idle, AgentLoopEvent.Interrupt, ({ state }) => state)
              .on(AgentLoopState.Resolving, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                updateQueueOnState(state, appendSteeringItem(state.queue, event.item)),
              )
              .on(AgentLoopState.Resolving, AgentLoopEvent.Interrupt, ({ state }) =>
                markTurnInterrupted(state),
              )
              .on(AgentLoopState.Resolving, AgentLoopEvent.Resolved, ({ state, event }) =>
                toStreamingState({ state, resolved: event }),
              )
              .on(AgentLoopState.Resolving, AgentLoopEvent.PhaseFailed, ({ state }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: state.agentOverride ?? state.currentAgent ?? "cowork",
                  streamFailed: true,
                  turnInterrupted: state.turnInterrupted,
                }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                Effect.gen(function* () {
                  if (event.urgent) {
                    yield* interruptActiveStream(activeStreamRef)
                  }
                  return updateQueueOnState(state, appendSteeringItem(state.queue, event.item))
                }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.Interrupt, ({ state }) =>
                interruptActiveStream(activeStreamRef).pipe(Effect.as(state)),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.StreamFinished, ({ state, event }) =>
                event.draft.toolCalls.length === 0
                  ? toFinalizingState({
                      state,
                      currentTurnAgent: event.currentTurnAgent,
                      usage: event.draft.usage,
                      streamFailed: false,
                      turnInterrupted: state.turnInterrupted,
                    })
                  : toExecutingToolsState({
                      state,
                      currentTurnAgent: event.currentTurnAgent,
                      draft: event.draft,
                    }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.StreamInterrupted, ({ state, event }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: event.currentTurnAgent,
                  streamFailed: false,
                  turnInterrupted: true,
                }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.StreamFailed, ({ state, event }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: event.currentTurnAgent,
                  streamFailed: true,
                  turnInterrupted: state.turnInterrupted,
                }),
              )
              .on(AgentLoopState.Streaming, AgentLoopEvent.PhaseFailed, ({ state }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: state.currentTurnAgent,
                  streamFailed: true,
                  turnInterrupted: state.turnInterrupted,
                }),
              )
              .on(
                AgentLoopState.ExecutingTools,
                AgentLoopEvent.QueueSteering,
                ({ state, event }) => {
                  const nextState = updateQueueOnState(
                    state,
                    appendSteeringItem(state.queue, event.item),
                  ) as ExecutingToolsState
                  return event.urgent ? markInterruptAfterTools(nextState) : nextState
                },
              )
              .on(AgentLoopState.ExecutingTools, AgentLoopEvent.Interrupt, ({ state }) =>
                markInterruptAfterTools(state),
              )
              .on(AgentLoopState.ExecutingTools, AgentLoopEvent.ToolsFinished, ({ state }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: state.currentTurnAgent,
                  usage: state.draft.usage,
                  streamFailed: false,
                  turnInterrupted: state.turnInterrupted || state.interruptAfterTools,
                }),
              )
              .on(AgentLoopState.ExecutingTools, AgentLoopEvent.PhaseFailed, ({ state }) =>
                toFinalizingState({
                  state,
                  currentTurnAgent: state.currentTurnAgent,
                  usage: state.draft.usage,
                  streamFailed: true,
                  turnInterrupted: state.turnInterrupted || state.interruptAfterTools,
                }),
              )
              .on(AgentLoopState.Finalizing, AgentLoopEvent.QueueSteering, ({ state, event }) =>
                updateQueueOnState(state, appendSteeringItem(state.queue, event.item)),
              )
              .on(AgentLoopState.Finalizing, AgentLoopEvent.Interrupt, ({ state }) =>
                markTurnInterrupted(state),
              )
              .on(AgentLoopState.Finalizing, AgentLoopEvent.FinalizeFinished, ({ state, event }) =>
                event.nextItem !== undefined
                  ? buildResolvingState(
                      {
                        queue: event.queue,
                        currentAgent: state.currentAgent,
                        handoffSuppress: event.handoffSuppress,
                      },
                      event.nextItem,
                    )
                  : buildIdleState({
                      queue: event.queue,
                      currentAgent: state.currentAgent,
                      handoffSuppress: event.handoffSuppress,
                    }),
              )
              .on(AgentLoopState.Finalizing, AgentLoopEvent.PhaseFailed, ({ state }) =>
                buildIdleState({
                  queue: state.queue,
                  currentAgent: state.currentAgent,
                  handoffSuppress: state.handoffSuppress,
                }),
              )
              .task(
                AgentLoopState.Resolving,
                ({ state }) =>
                  runResolvingState(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.resolve"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                {
                  name: "resolve",
                  onSuccess: (event) => event,
                  onFailure: () => AgentLoopEvent.PhaseFailed,
                },
              )
              .task(
                AgentLoopState.Streaming,
                ({ state }) =>
                  runStreamingState(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.stream"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                {
                  name: "stream",
                  onSuccess: (event) => event,
                  onFailure: () => AgentLoopEvent.PhaseFailed,
                },
              )
              .task(
                AgentLoopState.ExecutingTools,
                ({ state }) =>
                  runExecutingToolsState(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.tools"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                {
                  name: "tools",
                  onSuccess: (event) => event,
                  onFailure: () => AgentLoopEvent.PhaseFailed,
                },
              )
              .task(
                AgentLoopState.Finalizing,
                ({ state }) =>
                  runFinalizingState(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.finalize"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                {
                  name: "finalize",
                  onSuccess: (event) => event,
                  onFailure: () => AgentLoopEvent.PhaseFailed,
                },
              )
              .build()

            const loopActor = yield* Machine.spawn(
              loopMachine,
              `agent-loop:${sessionId}:${branchId}`,
            ).pipe(
              Effect.provideService(InspectorService, inspector),
              Effect.provideService(Scope.Scope, loopScope),
            )

            return {
              actor: loopActor,
              activeStreamRef,
              bashSemaphore,
              scope: loopScope,
            }
          })

        const getLoop = Effect.fn("AgentLoop.getLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          return yield* loopsSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const existing = (yield* Ref.get(loopsRef)).get(key)
              if (existing !== undefined) return existing
              const created = yield* makeLoop(sessionId, branchId)
              yield* Ref.update(loopsRef, (loops) => {
                const next = new Map(loops)
                next.set(key, created)
                return next
              })
              return created
            }),
          )
        })

        const findLoop = Effect.fn("AgentLoop.findLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          const loops = yield* Ref.get(loopsRef)
          return loops.get(key)
        })

        const findOrRestoreLoop = Effect.fn("AgentLoop.findOrRestoreLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const existing = yield* findLoop(sessionId, branchId)
          if (existing !== undefined) return existing

          const checkpoint = Option.getOrUndefined(
            yield* Effect.option(storage.getAgentLoopCheckpoint({ sessionId, branchId })),
          )
          if (checkpoint === undefined) return undefined

          return yield* getLoop(sessionId, branchId)
        })

        const service: AgentLoopService = {
          submit: Effect.fn("AgentLoop.submit")(function* (
            message: Message,
            options?: { bypass?: boolean },
          ) {
            const bypass = options?.bypass ?? true
            const loop = yield* getLoop(message.sessionId, message.branchId)
            const initialState = yield* loop.actor.snapshot
            const item: QueuedTurnItem = { message, bypass }

            if (initialState._tag !== "Idle") {
              const content = messageText(message)
              yield* loop.actor.sendAndWait(AgentLoopEvent.QueueFollowUp({ item }), (state) =>
                queueContainsContent(state.queue.followUp, content),
              )
              return
            }

            yield* loop.actor.sendAndWait(
              AgentLoopEvent.Start({ item }),
              (state) => state._tag !== "Idle",
            )
          }),

          run: Effect.fn("AgentLoop.run")(function* (
            message: Message,
            options?: { bypass?: boolean },
          ) {
            const bypass = options?.bypass ?? true
            const loop = yield* getLoop(message.sessionId, message.branchId)
            const initialState = yield* loop.actor.snapshot
            const item: QueuedTurnItem = { message, bypass }

            if (initialState._tag !== "Idle") {
              const content = messageText(message)
              yield* loop.actor.sendAndWait(AgentLoopEvent.QueueFollowUp({ item }), (state) =>
                queueContainsContent(state.queue.followUp, content),
              )
              return
            }

            yield* loop.actor.send(AgentLoopEvent.Start({ item }))
            yield* loop.actor.waitFor((state) => state._tag === "Idle" && state !== initialState)
          }),

          steer: (command) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(command.sessionId, command.branchId)
              const loopState = yield* loop.actor.snapshot

              switch (command._tag) {
                case "SwitchAgent":
                  yield* loop.actor.send(AgentLoopEvent.SwitchAgent({ agent: command.agent }))
                  return
                case "Cancel":
                case "Interrupt":
                  if (loopState._tag === "Streaming" || loopState._tag === "ExecutingTools") {
                    yield* loop.actor.send(AgentLoopEvent.Interrupt)
                  }
                  return
                case "Interject": {
                  const session = yield* storage
                    .getSession(command.sessionId)
                    .pipe(Effect.catchEager(() => Effect.void))
                  const bypass = session?.bypass ?? true
                  const interjectMessage = new Message({
                    id: Bun.randomUUIDv7() as MessageId,
                    sessionId: command.sessionId,
                    branchId: command.branchId,
                    kind: "interjection",
                    role: "user",
                    parts: [new TextPart({ type: "text", text: command.message })],
                    createdAt: new Date(),
                  })
                  const item: QueuedTurnItem = {
                    message: interjectMessage,
                    bypass,
                    ...(command.agent !== undefined ? { agentOverride: command.agent } : {}),
                  }
                  const urgent =
                    loopState._tag === "Streaming" || loopState._tag === "ExecutingTools"
                  const content = command.message
                  yield* loop.actor.sendAndWait(
                    AgentLoopEvent.QueueSteering({ item, urgent }),
                    (state) => queueContainsContent(state.queue.steering, content),
                  )
                  return
                }
              }
            }),

          followUp: (message) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(message.sessionId, message.branchId)
              const loopState = yield* loop.actor.snapshot
              if (countQueuedFollowUps(loopState.queue) >= DEFAULTS.followUpQueueMax) {
                return yield* new AgentLoopError({
                  message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                })
              }
              const session = yield* storage
                .getSession(message.sessionId)
                .pipe(Effect.catchEager(() => Effect.void))
              const bypass = session?.bypass ?? true
              const content = messageText(message)
              yield* loop.actor.sendAndWait(
                AgentLoopEvent.QueueFollowUp({ item: { message, bypass } }),
                (state) => queueContainsContent(state.queue.followUp, content),
              )
            }),

          drainQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                return { steering: [], followUp: [] }
              }

              const loopState = yield* loop.actor.snapshot
              const snapshot = queueSnapshotFromState(loopState)
              yield* loop.actor.sendAndWait(
                AgentLoopEvent.ClearQueue,
                (state) => state.queue.steering.length === 0 && state.queue.followUp.length === 0,
              )
              return snapshot
            }),

          getQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                return { steering: [], followUp: [] }
              }

              return queueSnapshotFromState(yield* loop.actor.snapshot)
            }),

          isRunning: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) return false
              return runtimeStateFromLoopState(yield* loop.actor.snapshot).status !== "idle"
            }),

          getState: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop !== undefined) {
                return runtimeStateFromLoopState(yield* loop.actor.snapshot)
              }

              return {
                status: "idle" as const,
                agent: yield* resolveStoredAgent({
                  storage,
                  sessionId: input.sessionId,
                  branchId: input.branchId,
                }),
                queueDepth: 0,
              }
            }),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const loops = yield* Ref.get(loopsRef)
            yield* Effect.forEach(
              Array.from(loops.values()),
              (loop) => Scope.close(loop.scope, Exit.void),
              { concurrency: "unbounded" },
            )
          }),
        )

        return service
      }),
    )

  static Test = (): Layer.Layer<AgentLoop> =>
    Layer.succeed(AgentLoop, {
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueue: () => Effect.succeed({ steering: [], followUp: [] }),
      isRunning: (_input) => Effect.succeed(false),
      getState: () => Effect.succeed({ status: "idle", agent: "cowork", queueDepth: 0 }),
    })
}

// ============================================================================
// Agent Actor (subagent runner)
// ============================================================================

const AgentRunInputFields = {
  sessionId: SessionId,
  branchId: BranchId,
  agentName: AgentName,
  prompt: Schema.String,
  systemPrompt: Schema.String,
  bypass: Schema.UndefinedOr(Schema.Boolean),
  modelId: Schema.optional(Schema.String),
  overrideAllowedActions: Schema.optional(Schema.Array(Schema.String)),
  overrideAllowedTools: Schema.optional(Schema.Array(Schema.String)),
  overrideDeniedTools: Schema.optional(Schema.Array(Schema.String)),
  overrideReasoningEffort: Schema.optional(ReasoningEffort),
  overrideSystemPromptAddendum: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
}

const AgentRunInputSchema = Schema.Struct(AgentRunInputFields)

export type AgentRunInput = typeof AgentRunInputSchema.Type

const AgentActorState = State({
  Idle: {},
  Running: { input: AgentRunInputSchema },
  Completed: {},
  Failed: { error: Schema.String },
})

const AgentActorEvent = Event({
  Start: { input: AgentRunInputSchema },
  Succeeded: {},
  Failed: { error: Schema.String },
})

const makeAgentMachine = (run: (input: AgentRunInput) => Effect.Effect<void, SubagentError>) =>
  Machine.make({
    state: AgentActorState,
    event: AgentActorEvent,
    initial: AgentActorState.Idle,
  })
    .on(AgentActorState.Idle, AgentActorEvent.Start, ({ event }) =>
      AgentActorState.Running({ input: event.input }),
    )
    .on(AgentActorState.Running, AgentActorEvent.Succeeded, () => AgentActorState.Completed)
    .on(AgentActorState.Running, AgentActorEvent.Failed, ({ event }) =>
      AgentActorState.Failed({ error: event.error }),
    )
    .task(AgentActorState.Running, ({ state }) => run(state.input), {
      name: "run",
      onSuccess: () => AgentActorEvent.Succeeded,
      onFailure: (cause) => AgentActorEvent.Failed({ error: Cause.pretty(cause) }),
    })
    .final(AgentActorState.Completed)
    .final(AgentActorState.Failed)
    .build()

export interface AgentActorService {
  readonly run: (input: AgentRunInput) => Effect.Effect<void, SubagentError>
}

export class AgentActor extends ServiceMap.Service<AgentActor, AgentActorService>()(
  "@gent/core/src/runtime/agent/agent-loop/AgentActor",
) {
  static Live: Layer.Layer<
    AgentActor,
    never,
    Storage | Provider | ExtensionRegistry | EventStore | ToolRunner
  > = Layer.effect(
    AgentActor,
    Effect.gen(function* () {
      const storage = yield* Storage
      const provider = yield* Provider
      const extensionRegistry = yield* ExtensionRegistry
      const eventStore = yield* EventStore
      const toolRunner = yield* ToolRunner
      const bashSemaphore = yield* Semaphore.make(1)

      const actorIdFor = (input: AgentRunInput) => `agent-${input.sessionId}-${input.branchId}`

      const publishMachineTaskSucceeded = Effect.fn("AgentActor.publishMachineTaskSucceeded")(
        function* (input: AgentRunInput) {
          yield* eventStore
            .publish(
              new MachineTaskSucceeded({
                sessionId: input.sessionId,
                branchId: input.branchId,
                actorId: actorIdFor(input),
                stateTag: "Running",
              }),
            )
            .pipe(
              Effect.catchEager((e) =>
                Effect.logWarning("failed to publish MachineTaskSucceeded", e),
              ),
            )
        },
      )

      const publishMachineTaskFailed = Effect.fn("AgentActor.publishMachineTaskFailed")(function* (
        input: AgentRunInput,
        cause: Cause.Cause<unknown>,
      ) {
        const error = Cause.pretty(cause)
        yield* eventStore
          .publish(
            new MachineTaskFailed({
              sessionId: input.sessionId,
              branchId: input.branchId,
              actorId: actorIdFor(input),
              stateTag: "Running",
              error,
            }),
          )
          .pipe(
            Effect.catchEager((e) => Effect.logWarning("failed to publish MachineTaskFailed", e)),
          )
      })

      const runEffect: (input: AgentRunInput) => Effect.Effect<void, SubagentError> = Effect.fn(
        "AgentActor.runEffect",
      )((input: AgentRunInput) =>
        Effect.gen(function* () {
          const agent = yield* extensionRegistry.getAgent(input.agentName)
          if (agent === undefined) {
            yield* eventStore.publish(
              new ErrorOccurred({
                sessionId: input.sessionId,
                branchId: input.branchId,
                error: `Unknown agent: ${input.agentName}`,
              }),
            )
            return yield* new SubagentError({ message: `Unknown agent: ${input.agentName}` })
          }

          const effectiveAgent = applyAgentOverrides(agent, input)

          const basePrompt = yield* extensionRegistry.hooks.runInterceptor(
            "prompt.system",
            {
              basePrompt: buildSystemPrompt(input.systemPrompt, effectiveAgent),
              agent: effectiveAgent,
            },
            (i) => Effect.succeed(i.basePrompt),
          )

          const userMessage = new Message({
            id: Bun.randomUUIDv7() as MessageId,
            sessionId: input.sessionId,
            branchId: input.branchId,
            role: "user",
            parts: [new TextPart({ type: "text", text: input.prompt })],
            createdAt: new Date(),
          })

          yield* storage.createMessage(userMessage)
          yield* eventStore.publish(
            new MessageReceived({
              sessionId: input.sessionId,
              branchId: input.branchId,
              messageId: userMessage.id,
              role: "user",
            }),
          )

          const tools = yield* extensionRegistry.listToolsForAgent(effectiveAgent, {
            sessionId: input.sessionId,
            branchId: input.branchId,
            agentName: input.agentName,
            tags: input.tags,
          })

          const messages: Message[] = [userMessage]
          let continueLoop = true

          while (continueLoop) {
            yield* eventStore.publish(
              new StreamStarted({ sessionId: input.sessionId, branchId: input.branchId }),
            )

            const modelId = (input.modelId as ModelId | undefined) ?? resolveAgentModel(agent)
            const reasoning = resolveReasoning(effectiveAgent)
            const streamEffect = yield* withRetry(
              provider.stream({
                model: modelId,
                messages: [...messages],
                tools: [...tools],
                systemPrompt: basePrompt,
                ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
                ...(reasoning !== undefined ? { reasoning } : {}),
              }),
              undefined,
              {
                onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
                  eventStore
                    .publish(
                      new ProviderRetrying({
                        sessionId: input.sessionId,
                        branchId: input.branchId,
                        attempt,
                        maxAttempts,
                        delayMs,
                        error: error.message,
                      }),
                    )
                    .pipe(Effect.orDie),
              },
            ).pipe(Effect.withSpan("AgentActor.provider.stream"))

            const textParts: string[] = []
            const reasoningParts: string[] = []
            const toolCalls: ToolCallPart[] = []
            let lastFinishChunk: FinishChunk | undefined

            yield* Stream.runForEach(streamEffect, (chunk) =>
              Effect.gen(function* () {
                if (chunk._tag === "TextChunk") {
                  textParts.push(chunk.text)
                  yield* eventStore.publish(
                    new EventStreamChunk({
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      chunk: chunk.text,
                    }),
                  )
                } else if (chunk._tag === "ReasoningChunk") {
                  reasoningParts.push(chunk.text)
                } else if (chunk._tag === "ToolCallChunk") {
                  const toolCall = new ToolCallPart({
                    type: "tool-call",
                    toolCallId: chunk.toolCallId,
                    toolName: chunk.toolName,
                    input: chunk.input,
                  })
                  toolCalls.push(toolCall)
                } else if (chunk._tag === "FinishChunk") {
                  lastFinishChunk = chunk
                }
              }),
            )

            yield* eventStore.publish(
              new StreamEnded({
                sessionId: input.sessionId,
                branchId: input.branchId,
                usage: lastFinishChunk?.usage,
              }),
            )

            const assistantParts: Array<TextPart | ReasoningPart | ToolCallPart> = []
            const reasoningText = reasoningParts.join("")
            if (reasoningText !== "") {
              assistantParts.push(new ReasoningPart({ type: "reasoning", text: reasoningText }))
            }
            const fullText = textParts.join("")
            if (fullText !== "") {
              assistantParts.push(new TextPart({ type: "text", text: fullText }))
            }
            assistantParts.push(...toolCalls)

            const assistantMessage = new Message({
              id: Bun.randomUUIDv7() as MessageId,
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "assistant",
              parts: assistantParts,
              createdAt: new Date(),
            })

            yield* storage.createMessage(assistantMessage)
            yield* eventStore.publish(
              new MessageReceived({
                sessionId: input.sessionId,
                branchId: input.branchId,
                messageId: assistantMessage.id,
                role: "assistant",
              }),
            )

            if (toolCalls.length > 0) {
              const toolResults = yield* Effect.forEach(
                toolCalls,
                (toolCall) =>
                  Effect.gen(function* () {
                    yield* eventStore.publish(
                      new ToolCallStarted({
                        sessionId: input.sessionId,
                        branchId: input.branchId,
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        input: toolCall.input,
                      }),
                    )

                    const tool = yield* extensionRegistry.getTool(toolCall.toolName)
                    const ctx: ToolContext = {
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      toolCallId: toolCall.toolCallId,
                      agentName: agent.name,
                    }
                    const run = toolRunner.run(toolCall, ctx, { bypass: input.bypass })
                    const result = yield* tool?.concurrency === "serial"
                      ? bashSemaphore.withPermits(1)(run)
                      : run

                    const outputSummary = summarizeToolOutput(result)
                    const isError = result.output.type === "error-json"
                    const toolCallFields = {
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      toolCallId: toolCall.toolCallId,
                      toolName: toolCall.toolName,
                      summary: outputSummary,
                      output: stringifyOutput(result.output.value),
                    }
                    yield* eventStore.publish(
                      isError
                        ? new ToolCallFailed(toolCallFields)
                        : new ToolCallSucceeded(toolCallFields),
                    )

                    return result
                  }),
                { concurrency: Math.max(1, DEFAULTS.toolConcurrency) },
              )

              const toolResultMessage = new Message({
                id: Bun.randomUUIDv7() as MessageId,
                sessionId: input.sessionId,
                branchId: input.branchId,
                role: "tool",
                parts: toolResults,
                createdAt: new Date(),
              })
              yield* storage.createMessage(toolResultMessage)
              messages.push(toolResultMessage)
              continueLoop = true
            } else {
              continueLoop = false
            }
          }
        }).pipe(
          Effect.tap(() => publishMachineTaskSucceeded(input)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : publishMachineTaskFailed(input, cause),
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : eventStore
                  .publish(
                    new ErrorOccurred({
                      sessionId: input.sessionId,
                      branchId: input.branchId,
                      error: Cause.pretty(cause),
                    }),
                  )
                  .pipe(
                    Effect.catchEager((e) =>
                      Effect.logWarning("failed to publish ErrorOccurred event", e),
                    ),
                  ),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.fail(new SubagentError({ message: Cause.pretty(cause), cause })),
          ),
        ),
      )

      const run: AgentActorService["run"] = Effect.fn("AgentActor.run")((input) =>
        Effect.gen(function* () {
          const inspector = makePublishingInspector({
            publishEvent: (event) => eventStore.publish(event).pipe(Effect.orDie),
            sessionId: input.sessionId,
            branchId: input.branchId,
          })

          const actorId = actorIdFor(input)
          const actor = yield* Machine.spawn(makeAgentMachine(runEffect), actorId).pipe(
            Effect.provideService(InspectorService, inspector),
            Effect.mapError((error) =>
              Schema.is(SubagentError)(error)
                ? error
                : new SubagentError({ message: String(error), cause: error }),
            ),
          )

          const terminal = yield* actor.sendAndWait(AgentActorEvent.Start({ input }))

          yield* actor.stop

          if (terminal._tag === "Failed") {
            return yield* new SubagentError({ message: terminal.error })
          }
        }),
      )

      return AgentActor.of({ run })
    }),
  )
}
