import {
  Cause,
  Context,
  DateTime,
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
  SubscriptionRef,
} from "effect"
import {
  AgentDefinition,
  AgentName,
  AgentRunError,
  DEFAULT_AGENT_NAME,
  RunSpecSchema,
  resolveAgentDriver,
  resolveAgentModel,
  type AgentRunOverrides,
  type RunSpec,
  type AgentName as AgentNameType,
} from "../../domain/agent.js"
import { type AnyCapabilityContribution } from "../../domain/capability.js"
import { emptyQueueSnapshot, type QueueSnapshot } from "../../domain/queue.js"
import { TaggedEnumClass } from "../../domain/schema-tagged-enum-class.js"
import {
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
  TurnCompleted,
  TurnRecoveryApplied,
  type AgentEvent,
  type EventEnvelope,
} from "../../domain/event.js"
import { EventPublisher, type EventPublisherService } from "../../domain/event-publisher.js"
import {
  Message,
  TextPart,
  ToolCallPart,
  type ImagePart,
  type ReasoningPart,
  ToolResultPart,
} from "../../domain/message.js"
import { ActorCommandId, BranchId, MessageId, SessionId, ToolCallId } from "../../domain/ids.js"
import { makeToolContext } from "../../domain/tool.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { makeAmbientExtensionHostContextDeps } from "../make-extension-host-context.js"
import { ConfigService } from "../config-service.js"
import { ModelRegistry } from "../model-registry.js"
import { calculateCost, type ModelId } from "../../domain/model.js"
import type { InteractionPendingError } from "../../domain/interaction-request.js"
import type { PromptSection } from "../../domain/prompt.js"
import { DEFAULTS } from "../../domain/defaults.js"
import { Storage, type StorageError, type StorageService } from "../../storage/sqlite-storage.js"
import { CheckpointStorage } from "../../storage/checkpoint-storage.js"
import {
  Provider,
  ProviderError,
  providerRequestFromMessages,
  type ProviderStreamPart,
  type ProviderService,
} from "../../providers/provider.js"
import {
  normalizeResponseParts,
  projectResponsePartsToMessageParts,
} from "../../providers/ai-transcript.js"
import { summarizeToolOutput, stringifyOutput } from "../../domain/tool-output.js"
import { hasMessage } from "../../domain/guards.js"
import { withRetry } from "../retry"
import { SessionProfileCache } from "../session-profile.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import { DriverRegistry, type DriverRegistryService } from "../extensions/driver-registry.js"
import {
  MachineEngine,
  type MachineEngineService,
} from "../extensions/resource-host/machine-engine.js"
import {
  ExtensionTurnControl,
  TurnControlError,
  type CurrentTurnControlOwnerService,
  type TurnControlEnvelope,
} from "../extensions/turn-control.js"
import { withWideEvent, WideEvent, providerStreamBoundary } from "../wide-event-boundary"
import type { ProviderAuthError, TurnError, TurnEvent } from "../../domain/driver.js"
import { ToolRunner, type ToolRunnerService } from "./tool-runner"
import { ResourceManager, type ResourceManagerService } from "../resource-manager.js"
import { Permission, type PermissionService } from "../../domain/permission.js"
import { AllowAllPermission, resolveSessionEnvironment } from "../session-runtime-context.js"
import {
  AGENT_LOOP_CHECKPOINT_VERSION,
  buildLoopCheckpointRecord,
  decodeLoopCheckpointState,
  shouldRetainLoopCheckpoint,
} from "./agent-loop.checkpoint.js"
import {
  appendFollowUpQueueState,
  appendSteeringItem,
  buildIdleState,
  buildRunningState,
  countQueuedFollowUps,
  emptyLoopQueueState,
  LoopRuntimeStateSchema,
  queueSnapshotFromQueueState,
  runtimeStateFromLoopState,
  takeNextQueuedTurn,
  toWaitingForInteractionState,
  updateCurrentAgentOnState,
  buildInitialAgentLoopState,
  projectRuntimeState,
  type AgentLoopState,
  type LoopQueueState,
  type AssistantDraft,
  type LoopRuntimeState,
  type LoopState,
  QueuedTurnItemSchema,
  type QueuedTurnItem,
  type ResolvedTurn,
  type RunningState,
} from "./agent-loop.state.js"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  buildTurnPromptSections,
  resolveReasoning,
  toolResultMessageIdForTurn,
} from "./agent-loop.utils.js"
import { compileSystemPrompt } from "../../domain/prompt.js"
import * as Response from "effect/unstable/ai/Response"

// ============================================================================
// Turn Phases (inlined from agent-loop-phases.ts)
// ============================================================================

const formatStreamErrorMessage = (streamError: unknown) => {
  if (streamError instanceof Error) return streamError.message
  if (hasMessage(streamError)) return streamError.message
  return String(streamError)
}

const toResponseFinishReason = (stopReason: string): Response.FinishReason => {
  switch (stopReason) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "pause":
    case "other":
    case "unknown":
      return stopReason
    default:
      return "unknown"
  }
}

type PublishEvent = (event: AgentEvent) => Effect.Effect<void, never>
type CommittedEvent<A> =
  | { readonly _tag: "changed"; readonly result: A; readonly envelope: EventEnvelope }
  | { readonly _tag: "unchanged"; readonly result: A; readonly envelope?: EventEnvelope }

type TurnFailureState =
  | { readonly count: number }
  | { readonly count: number; readonly error: AgentLoopError }

const findPersistedEvent = (params: {
  storage: StorageService
  sessionId: SessionId
  branchId: BranchId
  match: (envelope: EventEnvelope) => boolean
}) =>
  params.storage
    .listEvents({ sessionId: params.sessionId, branchId: params.branchId })
    .pipe(Effect.map((events) => [...events].reverse().find(params.match)))

const commitWithEvent = <A, E, R>(params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  mutation: Effect.Effect<CommittedEvent<A>, E, R>
}) =>
  Effect.gen(function* () {
    const committed = yield* params.storage.withTransaction(params.mutation)
    if (committed.envelope !== undefined) {
      yield* params.eventPublisher.deliver(committed.envelope)
    }
    return committed.result
  })

const persistMessageReceived = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  message: Message
}) =>
  commitWithEvent({
    storage: params.storage,
    eventPublisher: params.eventPublisher,
    mutation: Effect.gen(function* () {
      const existing = yield* params.storage.getMessage(params.message.id)
      if (existing !== undefined) {
        const envelope = yield* findPersistedEvent({
          storage: params.storage,
          sessionId: params.message.sessionId,
          branchId: params.message.branchId,
          match: (candidate) =>
            candidate.event._tag === "MessageReceived" &&
            candidate.event.message.id === params.message.id,
        })
        return {
          _tag: "unchanged" as const,
          result: existing,
          ...(envelope !== undefined ? { envelope } : {}),
        }
      }

      yield* params.storage.createMessageIfAbsent(params.message)
      const envelope = yield* params.eventPublisher.append(
        MessageReceived.make({
          message: params.message,
        }),
      )
      return { _tag: "changed" as const, result: params.message, envelope }
    }),
  })

const makeCommandId = () => ActorCommandId.make(Bun.randomUUIDv7())
const toolCallIdForCommand = (commandId: ActorCommandId) => ToolCallId.make(commandId)
const assistantMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.make(`${commandId}:assistant`)
const toolResultMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.make(`${commandId}:tool-result`)

const recordToolResultPhase = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  commandId: ActorCommandId
  sessionId: SessionId
  branchId: BranchId
  toolCallId: ToolCallId
  toolName: string
  output: unknown
  isError?: boolean
}) =>
  Effect.gen(function* () {
    const outputType = params.isError === true ? "error-json" : "json"
    const part = new ToolResultPart({
      type: "tool-result",
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      output: { type: outputType, value: params.output },
    })

    const message = Message.Regular.make({
      id: toolResultMessageIdForCommand(params.commandId),
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: "tool",
      parts: [part],
      createdAt: yield* DateTime.nowAsDate,
    })

    const isError = params.isError ?? false
    const toolCallFields = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      summary: summarizeToolOutput(part),
      output: stringifyOutput(part.output.value),
    }

    yield* commitWithEvent({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      mutation: Effect.gen(function* () {
        const existing = yield* params.storage.getMessage(message.id)
        if (existing !== undefined) {
          const envelope = yield* findPersistedEvent({
            storage: params.storage,
            sessionId: params.sessionId,
            branchId: params.branchId,
            match: (candidate) =>
              (candidate.event._tag === "ToolCallSucceeded" ||
                candidate.event._tag === "ToolCallFailed") &&
              candidate.event.toolCallId === params.toolCallId,
          })
          return {
            _tag: "unchanged" as const,
            result: existing,
            ...(envelope !== undefined ? { envelope } : {}),
          }
        }

        const result = yield* params.storage.createMessageIfAbsent(message)
        const envelope = yield* params.eventPublisher.append(
          isError ? ToolCallFailed.make(toolCallFields) : ToolCallSucceeded.make(toolCallFields),
        )
        return { _tag: "changed" as const, result, envelope }
      }),
    })
  })

export type ActiveStreamHandle = {
  abortController: AbortController
  interruptDeferred: Deferred.Deferred<void>
  interruptedRef: Ref.Ref<boolean>
}

/** Mutable accumulator for per-turn wide event fields. */
export type TurnMetrics = {
  agent: AgentNameType
  model: string
  inputTokens: number
  outputTokens: number
  toolCallCount: number
}

export const emptyTurnMetrics = (): TurnMetrics => ({
  agent: DEFAULT_AGENT_NAME,
  model: "",
  inputTokens: 0,
  outputTokens: 0,
  toolCallCount: 0,
})

interface ResolvedTurnContext extends ResolvedTurn {
  agent: AgentDefinition
  tools: ReadonlyArray<AnyCapabilityContribution>
}

type AssistantResponsePart = TextPart | ReasoningPart | ImagePart | ToolCallPart

interface TurnResponseMessages {
  readonly assistant: ReadonlyArray<AssistantResponsePart>
  readonly tool: ReadonlyArray<ToolResultPart>
  readonly usage?: AssistantDraft["usage"]
}

const toolCallsFromResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ReadonlyArray<ToolCallPart> =>
  parts.flatMap(
    (part): ReadonlyArray<ToolCallPart> =>
      part.type === "tool-call"
        ? [
            new ToolCallPart({
              type: "tool-call",
              toolCallId: ToolCallId.make(part.id),
              toolName: part.name,
              input: part.params,
            }),
          ]
        : [],
  )

const persistMessageParts = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  role: "assistant" | "tool"
  parts: ReadonlyArray<Message["parts"][number]>
  createdAt?: Date
}) =>
  Effect.gen(function* () {
    if (params.parts.length === 0) return undefined

    const message = Message.Regular.make({
      id: params.messageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: params.role,
      parts: [...params.parts],
      createdAt: params.createdAt ?? (yield* DateTime.nowAsDate),
    })

    const existing = yield* params.storage.getMessage(message.id)
    if (existing !== undefined) return existing

    return yield* persistMessageReceived({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      message,
    })
  })

const persistAssistantParts = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<AssistantResponsePart>
  createdAt?: Date
  agentName: AgentNameType
  extensionRegistry?: ExtensionRegistryService
  hostCtx?: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    if (
      params.extensionRegistry !== undefined &&
      params.hostCtx !== undefined &&
      params.parts.length > 0
    ) {
      yield* params.extensionRegistry.runtimeSlots.emitMessageOutput(
        {
          sessionId: params.sessionId,
          branchId: params.branchId,
          agentName: params.agentName,
          parts: [...params.parts],
        },
        params.hostCtx,
      )
    }

    return yield* persistMessageParts({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.messageId,
      role: "assistant",
      parts: params.parts,
      createdAt: params.createdAt,
    })
  })

const persistToolParts = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<ToolResultPart>
  createdAt?: Date
}) =>
  persistMessageParts({
    storage: params.storage,
    eventPublisher: params.eventPublisher,
    sessionId: params.sessionId,
    branchId: params.branchId,
    messageId: params.messageId,
    role: "tool",
    parts: params.parts,
    createdAt: params.createdAt,
  })

/**
 * Resolve the tool surface a driver expects, used by the `systemPrompt`
 * slot to decide whether to append/replace tool-section content.
 * External drivers expose this on `ExternalDriverContribution.toolSurface`
 * (defaulting to `"native"` when omitted); model drivers are always native.
 * Returns `undefined` when no driver is set.
 */
const resolveDriverToolSurface = (
  agent: AgentDefinition,
  driverRegistry: DriverRegistryService,
): Effect.Effect<"native" | "codemode" | undefined> =>
  Effect.gen(function* () {
    const driver = agent.driver
    if (driver === undefined) return undefined
    if (driver._tag === "model") return "native"
    const ext = yield* driverRegistry.getExternal(driver.id)
    return ext?.toolSurface ?? "native"
  })

const resolveTurnContext = (params: {
  agentOverride?: AgentNameType
  runSpec?: RunSpec
  currentAgent?: AgentNameType
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  extensionStateRuntime: MachineEngineService
  driverRegistry: DriverRegistryService
  sessionId: SessionId
  publishEvent: PublishEvent
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  hostCtx: ExtensionHostContext
}): Effect.Effect<ResolvedTurnContext | undefined, StorageError, ConfigService> =>
  Effect.gen(function* () {
    const currentAgent = params.agentOverride ?? params.currentAgent ?? DEFAULT_AGENT_NAME
    const rawMessages = yield* params.storage
      .listMessages(params.branchId)
      .pipe(Effect.map((items) => [...items]))
    const agent = yield* params.extensionRegistry.getAgent(currentAgent)
    if (agent === undefined) {
      yield* params
        .publishEvent(
          ErrorOccurred.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            error: `Unknown agent: ${currentAgent}`,
          }),
        )
        .pipe(Effect.orDie)
      return undefined
    }
    const effectiveAgent = applyAgentOverrides(agent, params.runSpec?.overrides)

    // Resolve runtime driver routing — `agent.driver` (hardcoded) wins,
    // then `UserConfig.driverOverrides[agent.name]`, else default.
    // `ConfigService` is a hard requirement of `AgentLoop.Live` — making
    // it optional here let test layers omit it and silently fall through
    // to the default driver, hiding wiring bugs.
    const configService = yield* ConfigService
    // Read driver overrides from the session's cwd. Without per-session
    // resolution, a multi-cwd server's project overrides would all
    // come from the launch cwd. `get(undefined)` falls back to the
    // launch-cwd cached config.
    const sessionConfig = yield* configService.get(params.hostCtx.cwd)
    const driverOverrides = sessionConfig.driverOverrides ?? undefined
    const driverResolution = resolveAgentDriver(effectiveAgent, driverOverrides)
    // If config-routed and the agent had no hardcoded driver, the
    // override replaces it — `effectiveAgent` is otherwise unchanged.
    const dispatchAgent =
      driverResolution.source === "config"
        ? AgentDefinition.make({ ...effectiveAgent, driver: driverResolution.driver })
        : effectiveAgent

    // Derive extension projections from state machines and explicit prompt/message slots.
    const allTools = yield* params.extensionRegistry.listModelCapabilities()
    const turnCtx = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      agent: effectiveAgent,
      allTools,
      interactive: params.interactive,
      tags: params.runSpec?.tags,
      agentName: currentAgent,
      parentToolCallId: params.runSpec?.parentToolCallId,
    }
    const projectionCtx = {
      sessionId: params.sessionId,
      branchId: params.branchId,
      cwd: params.hostCtx.cwd,
      home: params.hostCtx.home,
      sessionCwd: params.hostCtx.cwd,
      turn: turnCtx,
    }
    const interceptedMessages = yield* params.extensionRegistry.runtimeSlots.resolveContextMessages(
      {
        messages: rawMessages,
        agent: effectiveAgent,
        sessionId: params.sessionId,
        branchId: params.branchId,
      },
      { projection: projectionCtx, host: params.hostCtx },
    )

    // Filter out hidden messages — visible in transcript but excluded from LLM context
    const messages = interceptedMessages.filter((m) => m.metadata?.hidden !== true)

    // Evaluate `ProjectionContribution`-based projections — workflows no
    // longer carry a `turn.project` bridge field; per-turn prompt/policy is
    // exclusively the projection registry's responsibility now.
    const projEval = yield* params.extensionRegistry.getResolved().projections.evaluateTurn({
      ...projectionCtx,
    })
    const extensionProjections = [
      ...projEval.policyFragments.map((p) => ({ toolPolicy: p })),
      ...(projEval.promptSections.length > 0 ? [{ promptSections: projEval.promptSections }] : []),
    ]

    // Resolve tools + extension prompt sections via ToolPolicy compiler
    const { tools, promptSections: extensionSections } =
      yield* params.extensionRegistry.resolveToolPolicy(
        effectiveAgent,
        {
          sessionId: params.sessionId,
          branchId: params.branchId,
          agentName: currentAgent,
          interactive: params.interactive,
          tags: params.runSpec?.tags,
          parentToolCallId: params.runSpec?.parentToolCallId,
        },
        extensionProjections,
      )

    // Build tool-aware prompt, then run through explicit prompt slots.
    // We hand the slot layer both the compiled `basePrompt` (for append-only
    // rewrites) AND the structured `sections` (for slots
    // that need to swap or strip a section by id, e.g. codemode replacing
    // `tool-list` / `tool-guidelines` rather than appending a contradicting
    // surface).
    const allAgents = yield* params.extensionRegistry.listAgents()
    const sections = buildTurnPromptSections(
      params.baseSections,
      effectiveAgent,
      tools,
      extensionSections,
      allAgents,
    )
    const turnPrompt = compileSystemPrompt(sections)
    const driverToolSurface = yield* resolveDriverToolSurface(dispatchAgent, params.driverRegistry)
    const systemPrompt = yield* params.extensionRegistry.runtimeSlots.resolveSystemPrompt(
      {
        basePrompt: turnPrompt,
        agent: dispatchAgent,
        interactive: params.interactive,
        driverSource: driverResolution.source,
        tools,
        ...(driverToolSurface !== undefined ? { driverToolSurface } : {}),
        sections,
      },
      { projection: projectionCtx, host: params.hostCtx },
    )
    const session = yield* params.storage
      .getSession(params.sessionId)
      .pipe(Effect.catchEager(() => Effect.void))

    return {
      currentTurnAgent: currentAgent,
      messages,
      agent: dispatchAgent,
      tools,
      systemPrompt,
      modelId: params.runSpec?.overrides?.modelId ?? resolveAgentModel(dispatchAgent),
      reasoning: resolveReasoning(dispatchAgent, session?.reasoningLevel),
      temperature: dispatchAgent.temperature,
      driver: dispatchAgent.driver,
      driverSource: driverResolution.source,
    }
  })

interface CollectedTurnResponse {
  readonly responseParts: ReadonlyArray<Response.AnyPart>
  readonly messageProjection: TurnResponseMessages
  readonly interrupted: boolean
  readonly streamFailed: boolean
  readonly driverKind: "model" | "external"
}

interface ExternalTurnUsage {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
}

const isModelFinishUsage = (
  usage: Response.FinishPart["usage"] | ExternalTurnUsage,
): usage is Response.FinishPart["usage"] =>
  typeof usage.inputTokens === "object" || typeof usage.outputTokens === "object"

const finishedUsage = (
  usage: Response.FinishPart["usage"] | ExternalTurnUsage,
): AssistantDraft["usage"] | undefined => {
  if (usage === undefined) return undefined
  if (!isModelFinishUsage(usage)) {
    return {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    }
  }
  return {
    inputTokens: usage.inputTokens?.total ?? 0,
    outputTokens: usage.outputTokens?.total ?? 0,
  }
}

const collectNormalizedResponse = (params: {
  responseParts: ReadonlyArray<Response.AnyPart>
  streamFailed: boolean
  interrupted: boolean
  driverKind: "model" | "external"
}): CollectedTurnResponse => {
  const normalized = normalizeResponseParts(params.responseParts)
  const messages = projectResponsePartsToMessageParts(normalized)
  const usage = normalized
    .filter((part): part is Response.FinishPart => part.type === "finish")
    .map((part) => finishedUsage(part.usage))
    .find((part) => part !== undefined)

  return {
    responseParts: normalized,
    messageProjection: {
      assistant: messages.assistant,
      tool: messages.tool,
      ...(usage !== undefined ? { usage } : {}),
    },
    interrupted: params.interrupted,
    streamFailed: params.streamFailed,
    driverKind: params.driverKind,
  }
}

const isObservableModelOutputPart = (part: Response.AnyPart): boolean => {
  switch (part.type) {
    case "text":
      return part.text.length > 0
    case "text-delta":
      return part.delta.length > 0
    case "reasoning":
      return part.text.length > 0
    case "reasoning-delta":
      return part.delta.length > 0
    case "file":
    case "tool-call":
    case "tool-approval-request":
      return true
    case "tool-result":
      return part.preliminary !== true
    default:
      return false
  }
}

const collectModelTurnResponse = (params: {
  turnStream: Stream.Stream<ProviderStreamPart, ProviderError>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  modelId: string
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: ProviderError) => string
  retryPreOutputFailures?: boolean
}) =>
  Effect.gen(function* () {
    const responseParts: Response.AnyPart[] = []
    let hasObservableOutput = false

    const streamFailed = yield* Stream.runForEach(
      params.turnStream.pipe(
        Stream.interruptWhen(Deferred.await(params.activeStream.interruptDeferred)),
      ),
      (part) =>
        Effect.gen(function* () {
          if (part.type === "error") {
            return yield* new ProviderError({
              message: formatStreamErrorMessage(part.error),
              model: params.modelId,
              cause: part.error,
            })
          }
          responseParts.push(part)
          hasObservableOutput = hasObservableOutput || isObservableModelOutputPart(part)
          if (part.type === "text-delta") {
            yield* params
              .publishEvent(
                new EventStreamChunk({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  chunk: part.delta,
                }),
              )
              .pipe(Effect.orDie)
          }
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchTag("ProviderError", (streamError) =>
        Effect.gen(function* () {
          const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
          if (interrupted) return false
          if (params.retryPreOutputFailures === true && !hasObservableOutput) {
            return yield* streamError
          }
          yield* Effect.logWarning("stream error, persisting partial output").pipe(
            Effect.annotateLogs({ error: String(streamError) }),
          )
          yield* params
            .publishEvent(
              StreamEnded.make({ sessionId: params.sessionId, branchId: params.branchId }),
            )
            .pipe(Effect.orDie)
          yield* params
            .publishEvent(
              ErrorOccurred.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                error: params.formatStreamError(streamError),
              }),
            )
            .pipe(Effect.orDie)
          return true
        }),
      ),
    )

    const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
    return collectNormalizedResponse({
      responseParts,
      streamFailed,
      interrupted,
      driverKind: "model",
    })
  })

const collectFailedModelTurnResponse = (params: {
  streamError: ProviderError
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: ProviderError) => string
}) =>
  Effect.gen(function* () {
    const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
    if (!interrupted) {
      yield* Effect.logWarning("stream error before output, retries exhausted").pipe(
        Effect.annotateLogs({ error: String(params.streamError) }),
      )
      yield* params
        .publishEvent(StreamEnded.make({ sessionId: params.sessionId, branchId: params.branchId }))
        .pipe(Effect.orDie)
      yield* params
        .publishEvent(
          ErrorOccurred.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            error: params.formatStreamError(params.streamError),
          }),
        )
        .pipe(Effect.orDie)
    }

    return collectNormalizedResponse({
      responseParts: [],
      streamFailed: !interrupted,
      interrupted,
      driverKind: "model",
    })
  })

const collectExternalTurnResponse = (params: {
  turnStream: Stream.Stream<TurnEvent, TurnError>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: TurnError) => string
}) =>
  Effect.gen(function* () {
    const responseParts: Response.AnyPart[] = []
    // External drivers emit `ToolCompleted`/`ToolFailed` without the
    // `toolName` (ACP's status-update payload doesn't carry it). Track
    // name by id from `tool-call`/`tool-started` so completion events
    // and persisted `tool-result` parts carry the real tool name
    // instead of a hardcoded "external".
    const toolNamesById = new Map<string, string>()
    const toolCallIdsSeen = new Set<string>()

    const streamFailed = yield* Stream.runForEach(
      params.turnStream.pipe(
        Stream.interruptWhen(Deferred.await(params.activeStream.interruptDeferred)),
      ),
      (event) =>
        Effect.gen(function* () {
          switch (event._tag) {
            case "text-delta":
              responseParts.push(Response.makePart("text", { text: event.text }))
              yield* params
                .publishEvent(
                  new EventStreamChunk({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    chunk: event.text,
                  }),
                )
                .pipe(Effect.orDie)
              return
            case "reasoning-delta":
              responseParts.push(Response.makePart("reasoning", { text: event.text }))
              return
            case "tool-call":
              toolNamesById.set(event.toolCallId, event.toolName)
              if (!toolCallIdsSeen.has(event.toolCallId)) {
                toolCallIdsSeen.add(event.toolCallId)
                responseParts.push(
                  Response.makePart("tool-call", {
                    id: event.toolCallId,
                    name: event.toolName,
                    params: event.input,
                    providerExecuted: false,
                  }),
                )
              }
              return
            case "tool-started":
              toolNamesById.set(event.toolCallId, event.toolName)
              if (!toolCallIdsSeen.has(event.toolCallId)) {
                toolCallIdsSeen.add(event.toolCallId)
                responseParts.push(
                  Response.makePart("tool-call", {
                    id: event.toolCallId,
                    name: event.toolName,
                    params: event.input ?? {},
                    providerExecuted: false,
                  }),
                )
              }
              yield* params
                .publishEvent(
                  ToolCallStarted.make({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.make(event.toolCallId),
                    toolName: event.toolName,
                  }),
                )
                .pipe(Effect.orDie)
              return
            case "tool-completed": {
              const toolName = toolNamesById.get(event.toolCallId) ?? "external"
              const output = event.output ?? null
              responseParts.push(
                Response.makePart("tool-result", {
                  id: event.toolCallId,
                  name: toolName,
                  result: output,
                  isFailure: false,
                  providerExecuted: false,
                  // `encodedResult` is what `projectResponsePartsToMessageParts`
                  // reads into `ToolResultPart.output.value` — must mirror
                  // `result` or the stored tool message loses the output.
                  encodedResult: output,
                  preliminary: false,
                }),
              )
              yield* params
                .publishEvent(
                  ToolCallSucceeded.make({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.make(event.toolCallId),
                    toolName,
                  }),
                )
                .pipe(Effect.orDie)
              return
            }
            case "tool-failed": {
              const toolName = toolNamesById.get(event.toolCallId) ?? "external"
              // Mirror the model-driver failure shape from tool-runner: the
              // canonical `error-json` value is a discriminated object
              // `{ error: string }`. Downstream consumers (prompt
              // reconstruction, TUI) expect this structure regardless of
              // driver kind.
              const failurePayload = { error: event.error }
              responseParts.push(
                Response.makePart("tool-result", {
                  id: event.toolCallId,
                  name: toolName,
                  result: failurePayload,
                  isFailure: true,
                  providerExecuted: false,
                  encodedResult: failurePayload,
                  preliminary: false,
                }),
              )
              yield* params
                .publishEvent(
                  ToolCallFailed.make({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.make(event.toolCallId),
                    toolName,
                    output: event.error,
                  }),
                )
                .pipe(Effect.orDie)
              return
            }
            case "finished":
              responseParts.push(
                Response.makePart("finish", {
                  reason: toResponseFinishReason(event.stopReason),
                  usage: new Response.Usage({
                    inputTokens: {
                      uncached: undefined,
                      total: event.usage?.inputTokens,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: event.usage?.outputTokens,
                      text: undefined,
                      reasoning: undefined,
                    },
                  }),
                  response: undefined,
                }),
              )
              return
          }
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchTag("TurnError", (streamError) =>
        Effect.gen(function* () {
          const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
          if (interrupted) return false
          yield* Effect.logWarning("stream error, persisting partial output").pipe(
            Effect.annotateLogs({ error: String(streamError) }),
          )
          yield* params
            .publishEvent(
              StreamEnded.make({ sessionId: params.sessionId, branchId: params.branchId }),
            )
            .pipe(Effect.orDie)
          yield* params
            .publishEvent(
              ErrorOccurred.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                error: params.formatStreamError(streamError),
              }),
            )
            .pipe(Effect.orDie)
          return true
        }),
      ),
    )

    const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
    return collectNormalizedResponse({
      responseParts,
      streamFailed,
      interrupted,
      driverKind: "external",
    })
  })

/** InteractionPendingError enriched with the toolCallId that triggered it */
class ToolInteractionPending {
  readonly _tag = "ToolInteractionPending" as const
  constructor(
    readonly pending: InteractionPendingError,
    readonly toolCallId: ToolCallId,
  ) {}
}

const executeToolCalls = (params: {
  toolCalls: ReadonlyArray<ToolCallPart>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  hostCtx: ExtensionHostContext
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  permission?: PermissionService
  resourceManager: ResourceManagerService
}) =>
  Effect.forEach(
    params.toolCalls,
    (toolCall) =>
      Effect.gen(function* () {
        yield* params.publishEvent(
          ToolCallStarted.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          }),
        )

        const ctx = makeToolContext(
          {
            ...params.hostCtx,
            agentName: params.currentTurnAgent,
          },
          toolCall.toolCallId,
        )
        const run = params.toolRunner
          .run(toolCall, ctx, {
            registry: params.extensionRegistry,
            ...(params.permission !== undefined ? { permission: params.permission } : {}),
          })
          .pipe(Effect.mapError((e) => new ToolInteractionPending(e, toolCall.toolCallId)))
        const tool = yield* params.extensionRegistry.getModelCapability(toolCall.toolName)
        const result = yield* params.resourceManager.withResources(tool?.resources ?? [], run)

        const outputSummary = summarizeToolOutput(result)
        const isError = result.output.type === "error-json"
        const toolCallFields = {
          sessionId: params.sessionId,
          branchId: params.branchId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          summary: outputSummary,
          output: stringifyOutput(result.output.value),
        }
        yield* params.publishEvent(
          isError ? ToolCallFailed.make(toolCallFields) : ToolCallSucceeded.make(toolCallFields),
        )
        yield* Effect.logInfo("tool.completed").pipe(
          Effect.annotateLogs({
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            isError,
          }),
        )

        return result
      }),
    { concurrency: Math.max(1, DEFAULTS.toolConcurrency) },
  )

const resolveTurnPhase = (params: {
  message: Message
  agentOverride?: AgentNameType
  runSpec?: RunSpec
  currentAgent?: AgentNameType
  storage: StorageService
  branchId: BranchId
  extensionRegistry: ExtensionRegistryService
  extensionStateRuntime: MachineEngineService
  driverRegistry: DriverRegistryService
  sessionId: SessionId
  publishEvent: PublishEvent
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    yield* persistMessageReceived({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      message: params.message,
    })

    const resolved = yield* resolveTurnContext(params)
    if (resolved === undefined) return undefined

    return {
      currentTurnAgent: resolved.currentTurnAgent,
      messages: resolved.messages,
      systemPrompt: resolved.systemPrompt,
      modelId: resolved.modelId,
      tools: resolved.tools,
      agent: resolved.agent,
      ...(resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}),
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      ...(resolved.driver !== undefined ? { driver: resolved.driver } : {}),
      ...(resolved.driverSource !== undefined ? { driverSource: resolved.driverSource } : {}),
    } satisfies ResolvedTurn
  })

const runTurnBeforeHook = (
  extensionRegistry: ExtensionRegistryService,
  resolved: ResolvedTurn,
  sessionId: SessionId,
  branchId: BranchId,
  hostCtx: ExtensionHostContext,
) =>
  extensionRegistry.runtimeSlots.emitTurnBefore(
    {
      sessionId,
      branchId,
      agentName: resolved.currentTurnAgent,
      toolCount: resolved.tools?.length ?? 0,
      systemPromptLength: resolved.systemPrompt.length,
    },
    hostCtx,
  )

type ModelTurnSource = {
  readonly driverKind: "model"
  readonly driverId?: string
  readonly stream: Effect.Effect<
    Stream.Stream<ProviderStreamPart, ProviderError>,
    ProviderError | ProviderAuthError
  >
  readonly formatStreamError: (streamError: ProviderError) => string
  readonly collect: <R>(
    effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
  ) => Effect.Effect<CollectedTurnResponse, ProviderAuthError, R>
}

type ExternalTurnSource = {
  readonly driverKind: "external"
  readonly driverId?: string
  readonly stream: Stream.Stream<TurnEvent, TurnError>
  readonly formatStreamError: (streamError: TurnError) => string
  readonly collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

const resolveTurnEventStream = (params: {
  resolved: ResolvedTurnContext
  provider: ProviderService
  driverRegistry: DriverRegistryService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const { resolved } = params
    if (resolved.driver?._tag === "external") {
      const executor = yield* params.driverRegistry.getExternalExecutor(resolved.driver.id)
      if (executor === undefined) {
        yield* params
          .publishEvent(
            ErrorOccurred.make({
              sessionId: params.sessionId,
              branchId: params.branchId,
              error: `External driver "${resolved.driver.id}" not found`,
            }),
          )
          .pipe(Effect.orDie)
        return undefined
      }

      return {
        driverKind: "external" as const,
        driverId: resolved.driver.id,
        stream: executor.executeTurn({
          sessionId: params.sessionId,
          branchId: params.branchId,
          agent: resolved.agent,
          messages: resolved.messages,
          tools: resolved.tools,
          systemPrompt: resolved.systemPrompt,
          cwd: params.hostCtx.cwd,
          abortSignal: params.activeStream.abortController.signal,
          hostCtx: params.hostCtx,
        }),
        formatStreamError: (streamError: unknown) =>
          `External turn executor error: ${formatStreamErrorMessage(streamError)}`,
        collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      } satisfies ExternalTurnSource
    }

    const streamEffect = params.provider.stream(
      providerRequestFromMessages({
        model: resolved.modelId,
        messages: [...resolved.messages],
        tools: [...resolved.tools],
        systemPrompt: resolved.systemPrompt,
        abortSignal: params.activeStream.abortController.signal,
        ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
        ...(resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}),
        driverRegistry: params.driverRegistry,
        ...(resolved.driver?._tag === "model" && resolved.driver.id !== undefined
          ? { driverId: resolved.driver.id }
          : {}),
      }),
    )

    return {
      driverKind: "model" as const,
      stream: streamEffect,
      formatStreamError: formatStreamErrorMessage,
      collect: <R>(
        effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
      ) =>
        // `ProviderAuthError` is a fail-closed credential-absence signal —
        // not retryable, not recoverable mid-turn. Let it escape so the RPC
        // seam surfaces the typed auth failure; narrow the retry scope to
        // transient `ProviderError` only.
        withRetry(effect, undefined, {
          onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
            params
              .publishEvent(
                ProviderRetrying.make({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  attempt,
                  maxAttempts,
                  delayMs,
                  error: error.message,
                }),
              )
              .pipe(Effect.orDie),
        }).pipe(
          Effect.catchTag("ProviderError", (streamError) =>
            collectFailedModelTurnResponse({
              streamError,
              publishEvent: params.publishEvent,
              sessionId: params.sessionId,
              branchId: params.branchId,
              activeStream: params.activeStream,
              formatStreamError: formatStreamErrorMessage,
            }),
          ),
          Effect.tap((collected) =>
            WideEvent.set({
              inputTokens: collected.messageProjection.usage?.inputTokens ?? 0,
              outputTokens: collected.messageProjection.usage?.outputTokens ?? 0,
              toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
              interrupted: collected.interrupted,
              streamFailed: collected.streamFailed,
            }),
          ),
          withWideEvent(providerStreamBoundary(resolved.modelId)),
        ),
    } satisfies ModelTurnSource
  })

// Pricing snapshot lookup: given a modelId, yield current pricing (or
// undefined if not known). Resolved once per session at AgentLoop start so
// the per-turn emission path is context-free (the machine task R must stay
// narrow to what Machine.spawn provides).
export type PricingLookup = (
  modelId: ModelId,
) => Effect.Effect<{ readonly input: number; readonly output: number } | undefined>

// Freeze pricing into the StreamEnded event at emit time. Returns undefined
// when usage is absent or pricing is missing; the reducer treats that as a
// zero contribution. Storing the computed cost on the event makes the
// transcript authoritative: replaying the same events always sums to the
// same cost, even if ModelRegistry pricing later refreshes.
const computeStreamEndedCost = (params: {
  modelId: ModelId
  usage: { inputTokens: number; outputTokens: number } | undefined
  getPricing: PricingLookup
}): Effect.Effect<number | undefined> =>
  Effect.gen(function* () {
    if (params.usage === undefined) return undefined
    const pricing = yield* params.getPricing(params.modelId)
    if (pricing === undefined) return undefined
    return calculateCost(params.usage, pricing)
  })

const runTurnStreamPhase = (params: {
  messageId: MessageId
  step: number
  resolved: ResolvedTurnContext
  provider: ProviderService
  publishEvent: PublishEvent
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  extensionRegistry: ExtensionRegistryService
  driverRegistry: DriverRegistryService
  storage: StorageService
  hostCtx: ExtensionHostContext
  turnMetrics?: Ref.Ref<TurnMetrics>
  getPricing: PricingLookup
}) =>
  Effect.gen(function* () {
    const persistAssistantPartsLocal = (
      parts: ReadonlyArray<AssistantResponsePart>,
      createdAt?: Date,
    ) =>
      persistAssistantParts({
        storage: params.storage,
        eventPublisher: params.eventPublisher,
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: assistantMessageIdForTurn(params.messageId, params.step),
        parts,
        createdAt,
        agentName: params.resolved.currentTurnAgent,
        extensionRegistry: params.extensionRegistry,
        hostCtx: params.hostCtx,
      })

    const persistToolPartsLocal = (parts: ReadonlyArray<ToolResultPart>, createdAt?: Date) =>
      persistToolParts({
        storage: params.storage,
        eventPublisher: params.eventPublisher,
        sessionId: params.sessionId,
        branchId: params.branchId,
        messageId: toolResultMessageIdForTurn(params.messageId, params.step),
        parts,
        createdAt,
      })

    const source = yield* resolveTurnEventStream({
      resolved: params.resolved,
      provider: params.provider,
      driverRegistry: params.driverRegistry,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      activeStream: params.activeStream,
      hostCtx: params.hostCtx,
    })

    if (source === undefined) {
      // `resolveTurnEventStream` returns undefined only when the resolved
      // driver is external and its executor is missing — classify the
      // failed turn by the requested driver kind so the outer loop's
      // `driverKind === "external"` break still fires if the stream-failed
      // check is ever reordered.
      return {
        responseParts: [],
        messageProjection: { assistant: [], tool: [] },
        interrupted: false,
        streamFailed: true,
        driverKind: params.resolved.driver?._tag === "external" ? "external" : "model",
      } satisfies CollectedTurnResponse
    }

    yield* params
      .publishEvent(StreamStarted.make({ sessionId: params.sessionId, branchId: params.branchId }))
      .pipe(Effect.orDie)

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
            source.stream.pipe(
              Effect.flatMap((turnStream) =>
                collectModelTurnResponse({
                  turnStream,
                  publishEvent: params.publishEvent,
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  modelId: params.resolved.modelId,
                  activeStream: params.activeStream,
                  formatStreamError: source.formatStreamError,
                  retryPreOutputFailures: true,
                }),
              ),
            ),
          )
        : yield* source.collect(
            collectExternalTurnResponse({
              turnStream: source.stream,
              publishEvent: params.publishEvent,
              sessionId: params.sessionId,
              branchId: params.branchId,
              activeStream: params.activeStream,
              formatStreamError: source.formatStreamError,
            }),
          )

    if (collected.interrupted) {
      yield* params
        .publishEvent(
          StreamEnded.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            interrupted: true,
          }),
        )
        .pipe(Effect.orDie)
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
      getPricing: params.getPricing,
    })
    yield* params
      .publishEvent(
        StreamEnded.make({
          sessionId: params.sessionId,
          branchId: params.branchId,
          ...(collected.messageProjection.usage !== undefined
            ? { usage: collected.messageProjection.usage }
            : {}),
          model: params.resolved.modelId,
          ...(streamEndedCost !== undefined ? { costUsd: streamEndedCost } : {}),
        }),
      )
      .pipe(Effect.orDie)
    yield* Effect.logInfo("stream.end").pipe(
      Effect.annotateLogs({
        driverKind: source.driverKind,
        inputTokens: collected.messageProjection.usage?.inputTokens ?? 0,
        outputTokens: collected.messageProjection.usage?.outputTokens ?? 0,
        toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
      }),
    )

    if (params.turnMetrics !== undefined) {
      yield* Ref.update(params.turnMetrics, (m) => ({
        ...m,
        agent: params.resolved.currentTurnAgent,
        model: params.resolved.modelId,
        inputTokens: m.inputTokens + (collected.messageProjection.usage?.inputTokens ?? 0),
        outputTokens: m.outputTokens + (collected.messageProjection.usage?.outputTokens ?? 0),
        toolCallCount: m.toolCallCount + toolCallsFromResponseParts(collected.responseParts).length,
      }))
    }

    yield* persistAssistantPartsLocal(collected.messageProjection.assistant)
    yield* persistToolPartsLocal(collected.messageProjection.tool)

    return collected
  })

const executeToolsPhase = (params: {
  messageId: MessageId
  step: number
  toolCalls: ReadonlyArray<ToolCallPart>
  publishEvent: PublishEvent
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  hostCtx: ExtensionHostContext
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  permission?: PermissionService
  resourceManager: ResourceManagerService
  storage: StorageService
}) =>
  Effect.gen(function* () {
    if (params.toolCalls.length === 0) return

    const toolResultMessageId = toolResultMessageIdForTurn(params.messageId, params.step)
    const existing = yield* params.storage.getMessage(toolResultMessageId)
    if (existing !== undefined) return

    const toolResults = yield* executeToolCalls(params)
    yield* persistToolParts({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: toolResultMessageId,
      parts: toolResults,
    })
  })

export const invokeToolPhase = (params: {
  assistantMessageId: MessageId
  toolResultMessageId: MessageId
  toolCallId: ToolCallId
  toolName: string
  input: unknown
  publishEvent: PublishEvent
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  currentTurnAgent: AgentNameType
  toolRunner: ToolRunnerService
  extensionRegistry: ExtensionRegistryService
  permission?: PermissionService
  hostCtx: ExtensionHostContext
  resourceManager: ResourceManagerService
  storage: StorageService
}) =>
  Effect.gen(function* () {
    const toolCalls = [
      new ToolCallPart({
        type: "tool-call",
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        input: params.input,
      }),
    ] as const

    yield* persistAssistantParts({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.assistantMessageId,
      parts: toolCalls,
      agentName: params.currentTurnAgent,
      extensionRegistry: params.extensionRegistry,
      hostCtx: params.hostCtx,
    })

    const existing = yield* params.storage.getMessage(params.toolResultMessageId)
    if (existing !== undefined) return

    const toolResults = yield* executeToolCalls({
      toolCalls,
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      currentTurnAgent: params.currentTurnAgent,
      hostCtx: params.hostCtx,
      toolRunner: params.toolRunner,
      extensionRegistry: params.extensionRegistry,
      permission: params.permission,
      resourceManager: params.resourceManager,
    })
    yield* persistToolParts({
      storage: params.storage,
      eventPublisher: params.eventPublisher,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.toolResultMessageId,
      parts: toolResults,
    })
  })

const finalizeTurnPhase = (params: {
  storage: StorageService
  eventPublisher: Pick<EventPublisherService, "append" | "deliver">
  sessionId: SessionId
  branchId: BranchId
  startedAtMs: number
  messageId: MessageId
  turnInterrupted: boolean
  streamFailed?: boolean
  currentAgent: AgentNameType
  extensionRegistry: ExtensionRegistryService
  turnMetrics?: Ref.Ref<TurnMetrics>
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const existingMessage = yield* params.storage.getMessage(params.messageId)
    if (existingMessage?.turnDurationMs !== undefined) {
      const envelope = yield* findPersistedEvent({
        storage: params.storage,
        sessionId: params.sessionId,
        branchId: params.branchId,
        match: (candidate) =>
          candidate.event._tag === "TurnCompleted" &&
          candidate.event.messageId === params.messageId,
      })
      if (envelope !== undefined) {
        yield* params.eventPublisher.deliver(envelope)
      }
      return
    }

    const turnEndTime = yield* DateTime.now
    const turnDurationMs = DateTime.toEpochMillis(turnEndTime) - params.startedAtMs

    const envelope = yield* params.storage.withTransaction(
      Effect.gen(function* () {
        yield* params.storage.updateMessageTurnDuration(params.messageId, turnDurationMs)
        return yield* params.eventPublisher.append(
          TurnCompleted.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            messageId: params.messageId,
            durationMs: Number(turnDurationMs),
            ...(params.turnInterrupted ? { interrupted: true } : {}),
          }),
        )
      }),
    )
    yield* params.eventPublisher.deliver(envelope)

    yield* Effect.logDebug("finalize.turn-after.start")
    yield* params.extensionRegistry.runtimeSlots.emitTurnAfter(
      {
        sessionId: params.sessionId,
        branchId: params.branchId,
        durationMs: Number(turnDurationMs),
        agentName: params.currentAgent,
        interrupted: params.turnInterrupted,
      },
      params.hostCtx,
    )
    yield* Effect.logDebug("finalize.turn-after.done")

    yield* Effect.logInfo("turn.completed").pipe(
      Effect.annotateLogs({
        durationMs: Number(turnDurationMs),
        interrupted: params.turnInterrupted,
      }),
    )

    // Emit turn-level wide event with accumulated metrics
    if (params.turnMetrics !== undefined) {
      const metrics = yield* Ref.get(params.turnMetrics)
      let status: "ok" | "error" | "interrupted" = "ok"
      if (params.turnInterrupted) status = "interrupted"
      else if (params.streamFailed === true) status = "error"
      yield* Effect.logInfo("wide-event").pipe(
        Effect.annotateLogs({
          service: "agent-loop",
          method: "turn",
          actor: metrics.agent,
          sessionId: params.sessionId,
          branchId: params.branchId,
          model: metrics.model,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          toolCallCount: metrics.toolCallCount,
          durationMs: Number(turnDurationMs),
          interrupted: params.turnInterrupted,
          status,
        }),
      )
    }
  })

// Agent Loop Error

export class AgentLoopError extends Schema.TaggedErrorClass<AgentLoopError>()("AgentLoopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// Steer Command lives in `domain/steer.ts` so transport-contract and runtime
// can both import without taking a dependency on each other. Re-exported here
// for backwards-compatible call sites that already import from agent-loop.
import { SteerCommand } from "../../domain/steer.js"
export { SteerCommand }

const QueuedTurnCommandOptionFields = {
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
}

const LoopTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

const SubmitTurnCommand = Schema.TaggedStruct("SubmitTurn", {
  message: Message,
  ...QueuedTurnCommandOptionFields,
})
type SubmitTurnCommand = typeof SubmitTurnCommand.Type

const RunTurnCommand = Schema.TaggedStruct("RunTurn", {
  message: Message,
  ...QueuedTurnCommandOptionFields,
})
type RunTurnCommand = typeof RunTurnCommand.Type

const ApplySteerCommand = Schema.TaggedStruct("ApplySteer", {
  command: SteerCommand,
})
type ApplySteerCommand = typeof ApplySteerCommand.Type

const RespondInteractionCommand = Schema.TaggedStruct("RespondInteraction", {
  ...LoopTargetFields,
  requestId: Schema.String,
})
type RespondInteractionCommand = typeof RespondInteractionCommand.Type

const RecordToolResultCommand = Schema.TaggedStruct("RecordToolResult", {
  ...LoopTargetFields,
  commandId: Schema.optional(ActorCommandId),
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
})
type RecordToolResultCommand = typeof RecordToolResultCommand.Type

const InvokeToolCommand = Schema.TaggedStruct("InvokeTool", {
  ...LoopTargetFields,
  commandId: Schema.optional(ActorCommandId),
  toolName: Schema.String,
  input: Schema.Unknown,
})
type InvokeToolCommand = typeof InvokeToolCommand.Type

const LoopCommand = Schema.Union([
  SubmitTurnCommand,
  RunTurnCommand,
  ApplySteerCommand,
  RespondInteractionCommand,
  RecordToolResultCommand,
  InvokeToolCommand,
])
type LoopCommand = typeof LoopCommand.Type

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

    return Schema.is(AgentName)(raw) ? raw : DEFAULT_AGENT_NAME
  })

const hasAgentOverrides = (overrides: AgentRunOverrides | undefined) =>
  overrides?.allowedTools !== undefined ||
  overrides?.deniedTools !== undefined ||
  overrides?.reasoningEffort !== undefined ||
  overrides?.systemPromptAddendum !== undefined

const mergeSystemPromptAddendum = (
  base: string | undefined,
  addendum: string | undefined,
): string | undefined => {
  if (addendum === undefined) return base
  return base !== undefined ? `${base}\n\n${addendum}` : addendum
}

const applyAgentOverrides = (
  agent: AgentDefinition,
  overrides: AgentRunOverrides | undefined,
): AgentDefinition => {
  if (!hasAgentOverrides(overrides)) {
    return agent
  }

  const systemPromptAddendum = mergeSystemPromptAddendum(
    agent.systemPromptAddendum,
    overrides?.systemPromptAddendum,
  )

  return AgentDefinition.make({
    ...agent,
    ...(overrides?.allowedTools !== undefined ? { allowedTools: overrides.allowedTools } : {}),
    ...(overrides?.deniedTools !== undefined ? { deniedTools: overrides.deniedTools } : {}),
    ...(overrides?.reasoningEffort !== undefined
      ? { reasoningEffort: overrides.reasoningEffort }
      : {}),
    ...(systemPromptAddendum !== agent.systemPromptAddendum ? { systemPromptAddendum } : {}),
  })
}

// Driver event surface that replaces effect-machine's `actor.call(Event)`.
// Internal driver-event union. Each variant maps to a transition the FSM
// driver previously owned. Not persisted.
const LoopDriverEvent = TaggedEnumClass("LoopDriverEvent", {
  Start: { item: QueuedTurnItemSchema },
  Interrupt: {},
  SwitchAgent: { agent: AgentName },
  InteractionResponded: { requestId: Schema.String },
})
type LoopDriverEvent = Schema.Schema.Type<typeof LoopDriverEvent>

type LoopHandle = {
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  loopRef: SubscriptionRef.SubscriptionRef<AgentLoopState>
  idlePersistedRef: SubscriptionRef.SubscriptionRef<number>
  turnFailureRef: SubscriptionRef.SubscriptionRef<TurnFailureState>
  sideMutationSemaphore: Semaphore.Semaphore
  queueMutationSemaphore: Semaphore.Semaphore
  persistenceFailure: Effect.Effect<void, AgentLoopError>
  resolveTurnProfile: Effect.Effect<{
    turnExtensionRegistry: ExtensionRegistryService
    turnDriverRegistry: DriverRegistryService
    turnExtensionStateRuntime: MachineEngineService
    turnPermission: PermissionService
    turnBaseSections: ReadonlyArray<PromptSection>
    turnHostCtx: ExtensionHostContext
  }>
  persistState: (state: LoopState) => Effect.Effect<void, AgentLoopError>
  refreshRuntimeState: Effect.Effect<void, AgentLoopError>
  updateQueue: (
    update: (queue: LoopQueueState) => LoopQueueState,
  ) => Effect.Effect<void, AgentLoopError>
  persistQueueSnapshot: (
    state: LoopState,
    queue: LoopQueueState,
  ) => Effect.Effect<void, AgentLoopError>
  persistQueueCurrentState: (queue: LoopQueueState) => Effect.Effect<void, AgentLoopError>
  persistQueueState: (queue: LoopQueueState) => Effect.Effect<void, AgentLoopError>
  /** Read the current FSM state. Replaces effect-machine `actor.snapshot`. */
  snapshot: Effect.Effect<LoopState>
  /** Apply a driver event under the side-mutation semaphore. */
  dispatch: (event: LoopDriverEvent) => Effect.Effect<void, AgentLoopError>
  /** Recover from persisted checkpoint, then start the initial turn fiber if Running. */
  start: Effect.Effect<void>
  /** Resolves once the loop scope is closed. */
  awaitExit: Effect.Effect<void>
  resourceManager: ResourceManagerService
  closed: Deferred.Deferred<void>
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
      ErrorOccurred.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        error: Cause.pretty(params.cause),
      }),
    )
    .pipe(
      Effect.catchEager((error) =>
        Effect.logWarning("failed to publish ErrorOccurred").pipe(
          Effect.annotateLogs({ error: String(error) }),
        ),
      ),
      Effect.asVoid,
    )

const causeToAgentLoopError = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return Schema.is(AgentLoopError)(error)
    ? error
    : new AgentLoopError({
        message: "Agent loop turn failed",
        cause: error,
      })
}

const awaitIdlePersisted = (
  loop: LoopHandle,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(loop.idlePersistedRef)
    if (current > baseline) return
    yield* SubscriptionRef.changes(loop.idlePersistedRef).pipe(
      Stream.filter((count) => count > baseline),
      Stream.runHead,
    )
  })

const failTurnFailureState = (state: TurnFailureState) =>
  Effect.fail(
    "error" in state
      ? state.error
      : new AgentLoopError({
          message: "Agent loop turn failed",
        }),
  )

const awaitTurnFailure = (
  loop: LoopHandle,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(loop.turnFailureRef)
    if (current.count > baseline) return yield* failTurnFailureState(current)
    const next = yield* SubscriptionRef.changes(loop.turnFailureRef).pipe(
      Stream.filter((state) => state.count > baseline),
      Stream.runHead,
    )
    if (Option.isSome(next)) return yield* failTurnFailureState(next.value)
    return yield* new AgentLoopError({
      message: "Agent loop turn failure stream ended",
    })
  })

const failIfTurnFailedSince = (
  loop: LoopHandle,
  baseline: number,
): Effect.Effect<void, AgentLoopError> =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(loop.turnFailureRef)
    if (current.count > baseline) return yield* failTurnFailureState(current)
  })

type LoopRecoveryDecision = {
  state: LoopState
  queue: LoopQueueState
  recovery?: {
    phase: "Idle" | "Running" | "WaitingForInteraction"
    action: "resume-queued-turn" | "replay-running" | "restore-cold"
    detail?: string
  }
}

/** Recovery decision for persist.onRestore — takes decoded state, returns adjusted state or None. */
const makeRecoveryDecision = (params: {
  checkpoint: {
    state: LoopState
    queue: LoopQueueState
  }
  storage: StorageService
  extensionRegistry: ExtensionRegistryService
  currentAgent: AgentNameType
  publishEvent: (event: AgentEvent) => Effect.Effect<void, never>
  sessionId: SessionId
  branchId: BranchId
}): Effect.Effect<Option.Option<LoopRecoveryDecision>, StorageError> =>
  Effect.gen(function* () {
    const { state } = params.checkpoint
    const queue = params.checkpoint.queue

    const publishRecovery = (recovery: LoopRecoveryDecision["recovery"]) =>
      recovery === undefined
        ? Effect.void
        : params
            .publishEvent(
              TurnRecoveryApplied.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                phase: recovery.phase,
                action: recovery.action,
                ...(recovery.detail !== undefined ? { detail: recovery.detail } : {}),
              }),
            )
            .pipe(Effect.catchEager(() => Effect.void))

    if (state._tag === "Idle") {
      const { queue: remainingQueue, nextItem } = takeNextQueuedTurn(queue)
      if (nextItem !== undefined) {
        yield* publishRecovery({ phase: "Idle", action: "resume-queued-turn" })
        return Option.some({
          state: buildRunningState(
            { currentAgent: state.currentAgent ?? params.currentAgent },
            nextItem,
          ),
          queue: remainingQueue,
        })
      }
      return Option.some(
        state.currentAgent === undefined
          ? {
              state: updateCurrentAgentOnState(state, params.currentAgent),
              queue,
            }
          : {
              state,
              queue,
            },
      )
    }

    if (state._tag === "Running") {
      // The Running task will re-derive loop position from storage
      // (assistant message? tool results? → resume from correct point)
      yield* publishRecovery({ phase: "Running", action: "replay-running" })
      return Option.some({ state, queue })
    }

    if (state._tag === "WaitingForInteraction") {
      // Cold state — restore directly. Interaction re-publish happens via
      // InteractionStorage.listPending() in the server startup path.
      yield* publishRecovery({ phase: "WaitingForInteraction", action: "restore-cold" })
      return Option.some({ state, queue })
    }

    return Option.none()
  })

// Internal turn engine. Server-facing callers should go through SessionRuntime.

export interface AgentLoopService {
  readonly runOnce: (input: {
    sessionId: SessionId
    branchId: BranchId
    agentName: AgentNameType
    prompt: string
    interactive?: boolean
    runSpec?: RunSpec
  }) => Effect.Effect<void, AgentRunError>
  readonly submit: (
    message: Message,
    options?: {
      agentOverride?: AgentNameType
      runSpec?: RunSpec
      interactive?: boolean
    },
  ) => Effect.Effect<void, AgentLoopError>
  readonly run: (
    message: Message,
    options?: {
      agentOverride?: AgentNameType
      runSpec?: RunSpec
      interactive?: boolean
    },
  ) => Effect.Effect<void, AgentLoopError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void, AgentLoopError>
  readonly drainQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AgentLoopError>
  readonly getQueue: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AgentLoopError>
  readonly respondInteraction: (input: {
    sessionId: SessionId
    branchId: BranchId
    requestId: string
  }) => Effect.Effect<void, AgentLoopError>
  readonly recordToolResult: (input: {
    commandId?: ActorCommandId
    sessionId: SessionId
    branchId: BranchId
    toolCallId: ToolCallId
    toolName: string
    output: unknown
    isError?: boolean
  }) => Effect.Effect<void, AgentLoopError>
  readonly invokeTool: (input: {
    commandId?: ActorCommandId
    sessionId: SessionId
    branchId: BranchId
    toolName: string
    input: unknown
  }) => Effect.Effect<void, AgentLoopError>
  readonly getState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<LoopRuntimeState, AgentLoopError>
  readonly watchState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<Stream.Stream<LoopRuntimeState>, AgentLoopError>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void>
  readonly restoreSession: (sessionId: SessionId) => Effect.Effect<void>
}

export class AgentLoop extends Context.Service<AgentLoop, AgentLoopService>()(
  "@gent/core/src/runtime/agent/agent-loop/AgentLoop",
) {
  static Live = (config: {
    baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<
    AgentLoop,
    never,
    | Storage
    | CheckpointStorage
    | Provider
    | ExtensionRegistry
    | DriverRegistry
    | MachineEngine
    | ExtensionTurnControl
    | EventPublisher
    | ToolRunner
    | ResourceManager
    | ConfigService
    | ModelRegistry
  > =>
    Layer.effect(
      AgentLoop,
      Effect.gen(function* () {
        const storage = yield* Storage
        const checkpointStorage = yield* CheckpointStorage
        const provider = yield* Provider
        const extensionRegistry = yield* ExtensionRegistry
        const driverRegistry = yield* DriverRegistry
        const extensionStateRuntime = yield* MachineEngine
        const extensionTurnControl = yield* ExtensionTurnControl
        const eventPublisher = yield* EventPublisher
        const toolRunner = yield* ToolRunner
        const resourceManager = yield* ResourceManager
        // Yield ConfigService at setup so the captured service shape is
        // available to inner closures without leaking the requirement
        // into Stream/Machine task signatures.
        const configServiceForRun = yield* ConfigService
        // Capture ModelRegistry at setup so per-turn cost freezing (see
        // `computeStreamEndedCost`) is context-free on the hot path. The
        // pricing lookup stays an Effect so it can catch registry errors
        // without crossing into ProviderError.
        const modelRegistryForRun = yield* ModelRegistry
        const getPricing: PricingLookup = (modelId) =>
          modelRegistryForRun.get(modelId).pipe(
            Effect.map((m) => m?.pricing),
            Effect.catchEager(() => Effect.succeed(undefined)),
          )
        const loopsRef = yield* Ref.make<Map<string, LoopHandle>>(new Map())
        const mutationSemaphoresRef = yield* Ref.make<Map<string, Semaphore.Semaphore>>(new Map())
        const terminatedSessionsRef = yield* Ref.make<Set<SessionId>>(new Set())
        const loopsSemaphore = yield* Semaphore.make(1)
        const loopWatcherScope = yield* Scope.make()

        const stateKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`

        const getMutationSemaphore = Effect.fn("AgentLoop.getMutationSemaphore")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          const existing = (yield* Ref.get(mutationSemaphoresRef)).get(key)
          if (existing !== undefined) return existing

          const semaphore = yield* Semaphore.make(1)
          return yield* loopsSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const current = (yield* Ref.get(mutationSemaphoresRef)).get(key)
              if (current !== undefined) return current
              yield* Ref.update(mutationSemaphoresRef, (semaphores) => {
                const next = new Map(semaphores)
                next.set(key, semaphore)
                return next
              })
              return semaphore
            }),
          )
        })

        const removeLoopIfCurrent = (
          sessionId: SessionId,
          branchId: BranchId,
          handle: LoopHandle,
        ) =>
          loopsSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const key = stateKey(sessionId, branchId)
              yield* Ref.update(loopsRef, (loops) => {
                if (loops.get(key) !== handle) return loops
                const next = new Map(loops)
                next.delete(key)
                return next
              })
            }),
          )

        const closeLoopHandle = (handle: LoopHandle) =>
          Effect.gen(function* () {
            yield* interruptActiveStream(handle.activeStreamRef)
            yield* Deferred.succeed(handle.closed, undefined).pipe(Effect.ignore)
            yield* Scope.close(handle.scope, Exit.void)
          }).pipe(Effect.ignore)

        const cleanupLoopIfCurrent = (
          sessionId: SessionId,
          branchId: BranchId,
          handle: LoopHandle,
        ) =>
          removeLoopIfCurrent(sessionId, branchId, handle).pipe(
            Effect.andThen(closeLoopHandle(handle)),
            Effect.ignore,
          )

        const makeLoop = (
          sessionId: SessionId,
          branchId: BranchId,
          sideMutationSemaphore: Semaphore.Semaphore,
          initialQueue: LoopQueueState = emptyLoopQueueState(),
        ) =>
          Effect.gen(function* () {
            const publishEvent = (event: AgentEvent) =>
              eventPublisher.publish(event).pipe(
                Effect.mapError(
                  (error) =>
                    new AgentLoopError({
                      message: `Failed to publish ${event._tag}`,
                      cause: error,
                    }),
                ),
              )
            const publishEventOrDie = (event: AgentEvent) => publishEvent(event).pipe(Effect.orDie)

            // SessionProfileCache remains genuinely optional here. All other
            // host defaults are now resolved through the ambient host helper.
            const sessionProfileCache = yield* Effect.serviceOption(SessionProfileCache)
            const permissionService = yield* Effect.serviceOption(Permission)

            const hostDeps = yield* makeAmbientExtensionHostContextDeps({
              extensionStateRuntime,
              extensionRegistry,
              storage,
            })

            const profileCache =
              sessionProfileCache._tag === "Some" ? sessionProfileCache.value : undefined
            const defaultPermission =
              permissionService._tag === "Some" ? permissionService.value : AllowAllPermission

            /** Resolve a total per-turn environment: cwd → profile-backed services when present,
             *  otherwise server defaults. */
            const resolveTurnProfile = resolveSessionEnvironment({
              sessionId,
              branchId,
              storage,
              hostDeps,
              profileCache,
              defaults: {
                driverRegistry,
                permission: defaultPermission,
                baseSections: config.baseSections,
              },
            }).pipe(
              Effect.map(({ environment }) => ({
                turnExtensionRegistry: environment.extensionRegistry,
                turnDriverRegistry: environment.driverRegistry,
                turnExtensionStateRuntime: environment.extensionStateRuntime,
                turnPermission: environment.permission,
                turnBaseSections: environment.baseSections,
                turnHostCtx: environment.hostCtx,
              })),
            )

            const loopScope = yield* Scope.make()
            const activeStreamRef = yield* Ref.make<ActiveStreamHandle | undefined>(undefined)
            const turnMetricsRef = yield* Ref.make(emptyTurnMetrics())
            const interruptedRef = yield* Ref.make(false)
            const currentAgent = yield* resolveStoredAgent({ storage, sessionId, branchId })
            const initialLoopState = buildIdleState({ currentAgent })
            const loopRef = yield* SubscriptionRef.make<AgentLoopState>(
              buildInitialAgentLoopState({ state: initialLoopState, queue: initialQueue }),
            )
            const queueMutationSemaphore = yield* Semaphore.make(1)
            const idlePersistedRef = yield* SubscriptionRef.make(0)
            const turnFailureRef = yield* SubscriptionRef.make<TurnFailureState>({ count: 0 })
            const persistenceFailure = yield* Deferred.make<void, AgentLoopError>()
            const closed = yield* Deferred.make<void>()
            let started = false

            const persistRuntimeSnapshot = (state: LoopState, queue: LoopQueueState) =>
              Effect.gen(function* () {
                yield* Effect.logDebug("checkpoint.save.start").pipe(
                  Effect.annotateLogs({ nextState: state._tag }),
                )
                if (!shouldRetainLoopCheckpoint({ state, queue })) {
                  yield* checkpointStorage.remove({ sessionId, branchId })
                  yield* Effect.logDebug("checkpoint.save.removed")
                  // Update loopRef BEFORE the idle-bump signal so any
                  // `awaitIdlePersisted` waiter sees the new state when it
                  // wakes up. Bumping idlePersistedRef first makes that
                  // waiter race the loopRef update.
                  yield* SubscriptionRef.update(loopRef, (s) => ({
                    ...s,
                    state,
                    queue,
                    startingState: undefined,
                  }))
                  if (state._tag === "Idle") {
                    const count = yield* SubscriptionRef.get(idlePersistedRef)
                    yield* SubscriptionRef.set(idlePersistedRef, count + 1)
                  }
                  return
                }
                yield* checkpointStorage.upsert(
                  yield* buildLoopCheckpointRecord({
                    sessionId,
                    branchId,
                    state,
                    queue,
                  }),
                )
                yield* Effect.logDebug("checkpoint.save.done").pipe(
                  Effect.annotateLogs({ nextState: state._tag }),
                )
                yield* SubscriptionRef.update(loopRef, (s) => ({
                  ...s,
                  state,
                  queue,
                  startingState: undefined,
                }))
              }).pipe(
                Effect.mapError(
                  (error) =>
                    new AgentLoopError({
                      message: "Failed to persist agent loop checkpoint",
                      cause: error,
                    }),
                ),
              )

            const persistRuntimeState = (state: LoopState) =>
              SubscriptionRef.get(loopRef).pipe(
                Effect.flatMap((s) => persistRuntimeSnapshot(state, s.queue)),
              )

            const recordTurnFailure = (cause: Cause.Cause<unknown>) =>
              Effect.gen(function* () {
                const current = yield* SubscriptionRef.get(turnFailureRef)
                yield* SubscriptionRef.set(turnFailureRef, {
                  count: current.count + 1,
                  error: causeToAgentLoopError(cause),
                })
              })

            const currentLoopState = SubscriptionRef.get(loopRef).pipe(Effect.map((s) => s.state))

            const refreshRuntimeState = Effect.gen(function* () {
              if (!started) return
              yield* persistRuntimeState(yield* currentLoopState)
            })

            const updateQueue = (update: (queue: LoopQueueState) => LoopQueueState) =>
              queueMutationSemaphore.withPermits(1)(
                Effect.gen(function* () {
                  if (!started) return
                  const current = yield* SubscriptionRef.get(loopRef)
                  const nextQueue = update(current.queue)
                  yield* persistRuntimeSnapshot(current.state, nextQueue)
                }),
              )

            const persistQueueState = (nextQueue: LoopQueueState) =>
              Effect.gen(function* () {
                if (!started) return
                yield* persistRuntimeSnapshot(yield* currentLoopState, nextQueue)
              })

            const persistQueueSnapshot = (state: LoopState, nextQueue: LoopQueueState) =>
              persistRuntimeSnapshot(state, nextQueue)

            const persistQueueCurrentState = (nextQueue: LoopQueueState) =>
              SubscriptionRef.get(loopRef).pipe(
                Effect.flatMap((s) => persistRuntimeSnapshot(s.state, nextQueue)),
              )

            const takeNextQueuedTurnSerialized = queueMutationSemaphore.withPermits(1)(
              SubscriptionRef.modify(loopRef, (s) => {
                const { queue, nextItem } = takeNextQueuedTurn(s.queue)
                return [{ nextItem }, { ...s, queue }]
              }),
            )

            const switchAgentOnState = <S extends LoopState>(
              state: S,
              next: AgentNameType,
            ): Effect.Effect<S> =>
              Effect.gen(function* () {
                const previous = state.currentAgent ?? DEFAULT_AGENT_NAME
                if (previous === next) return state
                // Use per-session profile registry when available
                const { turnExtensionRegistry: switchRegistry } = yield* resolveTurnProfile
                const resolved = yield* switchRegistry.getAgent(next)
                if (resolved === undefined) return state

                yield* publishEvent(
                  AgentSwitched.make({
                    sessionId,
                    branchId,
                    fromAgent: previous,
                    toAgent: next,
                  }),
                ).pipe(
                  Effect.catchEager((error) =>
                    Effect.logWarning("failed to publish AgentSwitched").pipe(
                      Effect.annotateLogs({ error: String(error) }),
                    ),
                  ),
                )

                return updateCurrentAgentOnState(state, next)
              }).pipe(Effect.orDie) as Effect.Effect<S>

            // The result of a single Running turn. The driver branches on this
            // to decide the next state transition (W8-2: replaces the FSM
            // event return previously consumed by `Machine.task`).
            const TurnOutcome = TaggedEnumClass("TurnOutcome", {
              Done: {},
              InteractionRequested: {
                pendingRequestId: Schema.String,
                pendingToolCallId: Schema.String,
                currentTurnAgent: AgentName,
              },
            })
            type TurnOutcome = Schema.Schema.Type<typeof TurnOutcome>

            // ── The inner agentic loop ──
            // resolve → stream → tools → repeat until LLM returns no tool calls
            const runTurn = Effect.fn("AgentLoop.runTurn")(function* (state: RunningState) {
              yield* Ref.set(turnMetricsRef, emptyTurnMetrics())

              // Resolve per-turn environment before each model/tool step.
              const {
                turnExtensionRegistry,
                turnDriverRegistry,
                turnExtensionStateRuntime,
                turnPermission,
                turnBaseSections,
                turnHostCtx,
              } = yield* resolveTurnProfile

              let step = 0
              let interrupted = yield* Ref.get(interruptedRef)
              let streamFailed = false
              let currentTurnAgent: AgentNameType = state.currentAgent ?? DEFAULT_AGENT_NAME

              // Resume check: if assistant message with tool calls exists but no tool results,
              // we're resuming from WaitingForInteraction or crash. Execute tools first.
              // Resume always targets step 1 — interactions/crashes happen during the first tool execution.
              const resumeStep = 1
              const existingAssistant = yield* storage
                .getMessage(assistantMessageIdForTurn(state.message.id, resumeStep))
                .pipe(Effect.orElseSucceed(() => undefined))
              if (existingAssistant !== undefined && !interrupted) {
                const toolCalls = assistantDraftFromMessage(existingAssistant).toolCalls
                if (toolCalls.length > 0) {
                  const existingResults = yield* storage
                    .getMessage(toolResultMessageIdForTurn(state.message.id, resumeStep))
                    .pipe(Effect.orElseSucceed(() => undefined))
                  if (existingResults === undefined) {
                    // Resume tool execution (interaction response or crash recovery)
                    yield* Effect.logInfo("turn.resume-tools")
                    const interactionSignal = yield* executeToolsPhase({
                      messageId: state.message.id,
                      step: resumeStep,
                      toolCalls,
                      publishEvent: publishEventOrDie,
                      eventPublisher,
                      sessionId,
                      branchId,
                      currentTurnAgent,
                      hostCtx: turnHostCtx,
                      toolRunner,
                      extensionRegistry: turnExtensionRegistry,
                      permission: turnPermission,
                      resourceManager,
                      storage,
                    }).pipe(
                      Effect.as(undefined as ToolInteractionPending | undefined),
                      Effect.catchIf(
                        (e): e is ToolInteractionPending => e instanceof ToolInteractionPending,
                        (e) => Effect.succeed(e),
                      ),
                    )

                    if (interactionSignal !== undefined) {
                      const { pending, toolCallId } = interactionSignal
                      return TurnOutcome.InteractionRequested.make({
                        pendingRequestId: pending.requestId,
                        pendingToolCallId: toolCallId as string,
                        currentTurnAgent,
                      })
                    }
                    // Tools done — fall through to the loop which will resolve/stream the next step
                    step = 1
                  }
                  // If tool results already exist, the loop will re-resolve (picks them up from storage)
                }
              }

              while (true) {
                step++
                if (step > DEFAULTS.maxTurnSteps) {
                  yield* Effect.logWarning("turn.max-steps-exceeded").pipe(
                    Effect.annotateLogs({ step, max: DEFAULTS.maxTurnSteps }),
                  )
                  break
                }

                if (yield* Ref.get(interruptedRef)) {
                  interrupted = true
                  break
                }

                // 1. Resolve
                // ConfigService is required by `resolveTurnContext` (driver
                // override resolution). Provided here from the captured
                // service so the surrounding Machine task signature stays
                // requirement-free.
                const resolved = yield* resolveTurnPhase({
                  message: state.message,
                  agentOverride: state.agentOverride,
                  runSpec: state.runSpec,
                  currentAgent: state.currentAgent,
                  storage,
                  branchId,
                  extensionRegistry: turnExtensionRegistry,
                  extensionStateRuntime: turnExtensionStateRuntime,
                  driverRegistry: turnDriverRegistry,
                  sessionId,
                  publishEvent: publishEventOrDie,
                  eventPublisher,
                  baseSections: turnBaseSections,
                  interactive: state.interactive,
                  hostCtx: turnHostCtx,
                }).pipe(Effect.provideService(ConfigService, configServiceForRun))
                if (resolved === undefined) break

                currentTurnAgent = resolved.currentTurnAgent
                if (step === 1) {
                  yield* Ref.update(turnMetricsRef, (m) => ({
                    ...m,
                    agent: resolved.currentTurnAgent,
                    model: resolved.modelId,
                  }))
                }

                if (yield* Ref.get(interruptedRef)) {
                  interrupted = true
                  break
                }

                // 1b. Pre-turn hook
                yield* runTurnBeforeHook(
                  turnExtensionRegistry,
                  resolved,
                  sessionId,
                  branchId,
                  turnHostCtx,
                )

                // 2. Stream
                const activeStream: ActiveStreamHandle = {
                  abortController: new AbortController(),
                  interruptDeferred: yield* Deferred.make<void>(),
                  interruptedRef: yield* Ref.make(false),
                }
                yield* Ref.set(activeStreamRef, activeStream)

                const collected = yield* runTurnStreamPhase({
                  messageId: state.message.id,
                  step,
                  resolved,
                  provider,
                  extensionRegistry: turnExtensionRegistry,
                  driverRegistry: turnDriverRegistry,
                  hostCtx: turnHostCtx,
                  publishEvent: publishEventOrDie,
                  eventPublisher,
                  storage,
                  sessionId,
                  branchId,
                  activeStream,
                  turnMetrics: turnMetricsRef,
                  getPricing,
                }).pipe(Effect.ensuring(Ref.set(activeStreamRef, undefined)))

                if (collected.interrupted) {
                  interrupted = true
                  break
                }
                if (collected.streamFailed) {
                  streamFailed = true
                  break
                }

                // External drivers own their own tool execution — tool-call
                // parts we collected are historical transcript, not pending work.
                if (collected.driverKind === "external") break

                // No tool calls → LLM is done
                const toolCalls = toolCallsFromResponseParts(collected.responseParts)
                if (toolCalls.length === 0) break

                // 3. Execute tools
                const interactionSignal = yield* executeToolsPhase({
                  messageId: state.message.id,
                  step,
                  toolCalls,
                  publishEvent: publishEventOrDie,
                  eventPublisher,
                  sessionId,
                  branchId,
                  currentTurnAgent: resolved.currentTurnAgent,
                  hostCtx: turnHostCtx,
                  toolRunner,
                  extensionRegistry: turnExtensionRegistry,
                  permission: turnPermission,
                  resourceManager,
                  storage,
                }).pipe(
                  Effect.as(undefined as ToolInteractionPending | undefined),
                  Effect.catchIf(
                    (e): e is ToolInteractionPending => e instanceof ToolInteractionPending,
                    (e) => Effect.succeed(e),
                  ),
                )

                if (interactionSignal !== undefined) {
                  const { pending, toolCallId } = interactionSignal
                  return TurnOutcome.InteractionRequested.make({
                    pendingRequestId: pending.requestId,
                    pendingToolCallId: toolCallId as string,
                    currentTurnAgent: resolved.currentTurnAgent,
                  })
                }

                // Loop — tool results persisted, next resolve picks them up
              }

              // Finalize — TurnCompleted fires once per turn
              yield* finalizeTurnPhase({
                storage,
                eventPublisher,
                sessionId,
                branchId,
                startedAtMs: state.startedAtMs,
                messageId: state.message.id,
                turnInterrupted: interrupted,
                streamFailed,
                currentAgent: currentTurnAgent,
                extensionRegistry: turnExtensionRegistry,
                turnMetrics: turnMetricsRef,
                hostCtx: turnHostCtx,
              })

              return TurnOutcome.Done.make({})
            })

            // ── Plain-Effect driver (replaces effect-machine FSM) ──
            //
            // The previous FSM driver mediated state via `Machine.spawn`'s
            // event queue + transition table. With state already collapsed to
            // a single SubscriptionRef (W8-1), the driver is now a switch on
            // `state._tag` inside each method. The per-turn fiber is forked
            // with `Effect.forkIn(loopScope)`; its completion runs the
            // post-turn transition (Done/Failed → drain queue, Interaction →
            // cold state) inline.

            // Persistence is invoked at every state mutation that the FSM
            // previously handled via `lifecycle.durability.save`. The
            // `persistenceFailure` deferred mirrors the FSM's failure
            // channel so `awaitIdlePersisted` races can short-circuit;
            // the failure also propagates back through the dispatcher so
            // callers (e.g. `submit`) see the error directly — matching
            // the prior `actor.call(Event.Start)` semantics.
            const saveCheckpoint = (next: LoopState): Effect.Effect<void, AgentLoopError> =>
              persistRuntimeState(next).pipe(
                Effect.catchEager((error) =>
                  Deferred.fail(persistenceFailure, error).pipe(
                    Effect.asVoid,
                    Effect.andThen(Effect.fail(error)),
                  ),
                ),
                Effect.withSpan("AgentLoop.durability.save"),
              )

            // Forked per-turn fiber. Runs `runTurn`, then handles the outcome:
            //   Done             → next queued or Idle
            //   InteractionReq   → cold WaitingForInteraction
            //   Failure (cause)  → record failure, drain queue or Idle
            //
            // `sideMutationSemaphore` brackets the entire body. This matches
            // the FSM driver: `recordToolResult` / `invokeTool` and other
            // side-mutation dispatchers acquire the semaphore and therefore
            // wait for the active turn before applying. `Interrupt` is the
            // sole exception — it does NOT acquire the semaphore (see
            // `dispatch` below), so it can race the running turn the way
            // the FSM's actor event queue did.
            const runTurnFiber = (startState: RunningState): Effect.Effect<void, never> =>
              sideMutationSemaphore
                .withPermits(1)(
                  Effect.gen(function* () {
                    const outcome = yield* runTurn(startState).pipe(
                      Effect.annotateLogs({ sessionId, branchId }),
                      Effect.withSpan("AgentLoop.turn"),
                      Effect.tapCause((cause) =>
                        recordTurnFailure(cause).pipe(
                          Effect.andThen(
                            publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                          ),
                        ),
                      ),
                    )

                    if (outcome._tag === "InteractionRequested") {
                      const next = toWaitingForInteractionState({
                        state: startState,
                        currentTurnAgent: outcome.currentTurnAgent,
                        pendingRequestId: outcome.pendingRequestId,
                        pendingToolCallId: outcome.pendingToolCallId,
                      })
                      yield* saveCheckpoint(next)
                      return
                    }

                    // Done — drain queue or transition to Idle
                    const { nextItem } = yield* takeNextQueuedTurnSerialized
                    yield* Ref.set(interruptedRef, false)
                    if (nextItem !== undefined) {
                      const nextRunning = buildRunningState(
                        { currentAgent: startState.currentAgent },
                        nextItem,
                      )
                      yield* saveCheckpoint(nextRunning)
                      yield* forkTurn(nextRunning)
                      return
                    }
                    yield* saveCheckpoint(buildIdleState({ currentAgent: startState.currentAgent }))
                  }),
                )
                .pipe(
                  // Failure path mirrors the FSM's `onFailure: TurnFailed`:
                  // drain queue, replay if non-empty, otherwise Idle.
                  Effect.catchCause(() =>
                    sideMutationSemaphore.withPermits(1)(
                      Effect.gen(function* () {
                        const { nextItem } = yield* takeNextQueuedTurnSerialized
                        const current = yield* currentLoopState
                        yield* Ref.set(interruptedRef, false)
                        if (nextItem !== undefined) {
                          const nextRunning = buildRunningState(
                            { currentAgent: current.currentAgent },
                            nextItem,
                          )
                          yield* saveCheckpoint(nextRunning)
                          yield* forkTurn(nextRunning)
                          return
                        }
                        yield* saveCheckpoint(
                          buildIdleState({ currentAgent: current.currentAgent }),
                        )
                      }),
                    ),
                  ),
                  Effect.ignore,
                )

            const forkTurn = (startState: RunningState): Effect.Effect<void> =>
              Effect.forkIn(runTurnFiber(startState), loopScope).pipe(Effect.asVoid)

            // Public dispatch surface — replaces `actor.call(Event)` /
            // `actor.send(Event)`. Most events serialize via
            // `sideMutationSemaphore`. `Interrupt` for a running turn does
            // NOT acquire the semaphore — it must race the running turn,
            // mirroring the FSM driver where Interrupt was an event-queue
            // signal that ran independently of the in-flight `task`.
            const dispatch = (event: LoopDriverEvent): Effect.Effect<void, AgentLoopError> =>
              Effect.gen(function* () {
                if (event._tag === "Interrupt") {
                  // Race-safe: setting the flag + cancelling the stream are
                  // both single-step writes. The running turn observes the
                  // flag at its next checkpoint and exits.
                  const snap = yield* currentLoopState
                  if (snap._tag === "Idle") return
                  if (snap._tag === "Running") {
                    yield* Ref.set(interruptedRef, true)
                    yield* interruptActiveStream(activeStreamRef)
                    return
                  }
                  // WaitingForInteraction → Running with interrupt flag.
                  // The forked turn re-enters runTurn at step 0 and exits
                  // immediately because `interruptedRef === true`. State
                  // transition still needs the semaphore.
                  yield* sideMutationSemaphore.withPermits(1)(
                    Effect.gen(function* () {
                      const state = yield* currentLoopState
                      if (state._tag !== "WaitingForInteraction") return
                      yield* Ref.set(interruptedRef, true)
                      const resumed = buildRunningState(
                        { currentAgent: state.currentAgent },
                        {
                          message: state.message,
                          ...(state.agentOverride !== undefined
                            ? { agentOverride: state.agentOverride }
                            : {}),
                          ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
                          ...(state.interactive !== undefined
                            ? { interactive: state.interactive }
                            : {}),
                        },
                      )
                      yield* saveCheckpoint(resumed)
                      yield* forkTurn(resumed)
                    }),
                  )
                  return
                }

                yield* sideMutationSemaphore.withPermits(1)(
                  Effect.gen(function* () {
                    const state = yield* currentLoopState

                    switch (event._tag) {
                      case "Start": {
                        if (state._tag !== "Idle") return
                        // Clear stale interrupt before forking — prevents a stray
                        // Interrupt that latched after the prior turn ended from
                        // aborting this fresh turn.
                        yield* Ref.set(interruptedRef, false)
                        const next = buildRunningState(state, event.item)
                        yield* saveCheckpoint(next)
                        yield* forkTurn(next)
                        return
                      }
                      case "SwitchAgent": {
                        const next = yield* switchAgentOnState(state, event.agent)
                        if (next === state) return
                        yield* saveCheckpoint(next)
                        return
                      }
                      case "InteractionResponded": {
                        if (state._tag !== "WaitingForInteraction") return
                        // Clear stale interrupt before resuming the suspended turn.
                        yield* Ref.set(interruptedRef, false)
                        const resumed = buildRunningState(
                          { currentAgent: state.currentAgent },
                          {
                            message: state.message,
                            ...(state.agentOverride !== undefined
                              ? { agentOverride: state.agentOverride }
                              : {}),
                            ...(state.runSpec !== undefined ? { runSpec: state.runSpec } : {}),
                            ...(state.interactive !== undefined
                              ? { interactive: state.interactive }
                              : {}),
                          },
                        )
                        yield* saveCheckpoint(resumed)
                        yield* forkTurn(resumed)
                        return
                      }
                    }
                  }),
                )
              })

            // Recovery + initial fork. Replaces `Machine.spawn`'s
            // `lifecycle.recovery.resolve` + auto-start. Idempotent — guarded
            // by `started`.
            const start = Effect.gen(function* () {
              if (started) return
              started = true

              const record = yield* checkpointStorage
                .get({ sessionId, branchId })
                .pipe(Effect.catchEager(() => Effect.succeed(undefined)))
              if (record === undefined) return
              if (record.version !== AGENT_LOOP_CHECKPOINT_VERSION) {
                yield* checkpointStorage
                  .remove({ sessionId, branchId })
                  .pipe(Effect.catchEager(() => Effect.void))
                return
              }
              const decoded = yield* Effect.option(decodeLoopCheckpointState(record.stateJson))
              if (Option.isNone(decoded)) {
                yield* checkpointStorage
                  .remove({ sessionId, branchId })
                  .pipe(Effect.catchEager(() => Effect.void))
                return
              }
              const recovered = yield* makeRecoveryDecision({
                checkpoint: decoded.value,
                storage,
                extensionRegistry,
                currentAgent,
                publishEvent: publishEventOrDie,
                sessionId,
                branchId,
              }).pipe(Effect.catchEager(() => Effect.succeed(Option.none<LoopRecoveryDecision>())))

              if (Option.isNone(recovered)) return

              yield* SubscriptionRef.update(loopRef, (s) => ({
                ...s,
                state: recovered.value.state,
                queue: recovered.value.queue,
                startingState: undefined,
              }))
              if (recovered.value.state._tag === "Running") {
                yield* forkTurn(recovered.value.state as RunningState)
              }
            }).pipe(Effect.withSpan("AgentLoop.recovery.resolve"))

            return {
              activeStreamRef,
              loopRef,
              idlePersistedRef,
              turnFailureRef,
              sideMutationSemaphore,
              queueMutationSemaphore,
              persistenceFailure: Deferred.await(persistenceFailure),
              resolveTurnProfile,
              persistState: persistRuntimeState,
              refreshRuntimeState,
              updateQueue,
              persistQueueSnapshot,
              persistQueueCurrentState,
              persistQueueState,
              snapshot: currentLoopState,
              dispatch,
              start,
              awaitExit: Deferred.await(closed),
              resourceManager,
              closed,
              scope: loopScope,
            } satisfies LoopHandle
          })

        const getLoop = Effect.fn("AgentLoop.getLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          const sideMutationSemaphore = yield* getMutationSemaphore(sessionId, branchId)
          // Allocate + register under semaphore, then run `start` outside.
          // The plain-Effect driver does not auto-fork its turn fiber until
          // `start` is invoked, so the handle must be installed in loopsRef
          // before recovery runs — otherwise a recovered Running turn would
          // re-enter getLoop and deadlock waiting on the same semaphore.
          const created = yield* Effect.withSpan("AgentLoop.getLoop.semaphore")(
            loopsSemaphore.withPermits(1)(
              Effect.gen(function* () {
                if ((yield* Ref.get(terminatedSessionsRef)).has(sessionId)) {
                  return yield* new AgentLoopError({
                    message: `Session runtime terminated: ${sessionId}`,
                  })
                }
                const existing = (yield* Ref.get(loopsRef)).get(key)
                if (existing !== undefined) return undefined
                const handle = yield* makeLoop(sessionId, branchId, sideMutationSemaphore)
                yield* Ref.update(loopsRef, (loops) => {
                  const next = new Map(loops)
                  next.set(key, handle)
                  return next
                })
                return handle
              }),
            ),
          )
          if (created !== undefined) {
            yield* Effect.gen(function* () {
              yield* created.start
              if (yield* Deferred.isDone(created.closed)) {
                return yield* new AgentLoopError({
                  message: `Session runtime terminated: ${sessionId}`,
                })
              }
              yield* created.refreshRuntimeState
              yield* Effect.forkIn(
                created.awaitExit.pipe(
                  Effect.flatMap(() => cleanupLoopIfCurrent(sessionId, branchId, created)),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("agent-loop.exit-cleanup failed").pipe(
                      Effect.annotateLogs({ error: Cause.pretty(cause) }),
                    ),
                  ),
                ),
                loopWatcherScope,
              )
            }).pipe(
              Effect.catchEager((error) =>
                cleanupLoopIfCurrent(sessionId, branchId, created).pipe(
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            )
            return created
          }
          // Handle was installed by another fiber — guaranteed to exist
          // since the semaphore serializes creation for the same key.
          const loops = yield* Ref.get(loopsRef)
          const existing = loops.get(key)
          if (existing === undefined) {
            return yield* Effect.die(new Error(`Loop handle missing for ${key} after creation`))
          }
          return existing
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
          if ((yield* Ref.get(terminatedSessionsRef)).has(sessionId)) return undefined
          const existing = yield* findLoop(sessionId, branchId)
          if (existing !== undefined) return existing

          const checkpoint = Option.getOrUndefined(
            yield* Effect.option(checkpointStorage.get({ sessionId, branchId })),
          )
          if (checkpoint === undefined) return undefined

          return yield* getLoop(sessionId, branchId)
        })

        const buildQueuedTurnItem = (
          command: SubmitTurnCommand | RunTurnCommand,
        ): QueuedTurnItem => ({
          message: command.message,
          ...(command.agentOverride !== undefined ? { agentOverride: command.agentOverride } : {}),
          ...(command.runSpec !== undefined ? { runSpec: command.runSpec } : {}),
          ...(command.interactive !== undefined ? { interactive: command.interactive } : {}),
        })

        const currentRuntimeState = (loop: LoopHandle) =>
          SubscriptionRef.get(loop.loopRef).pipe(Effect.map(projectRuntimeState))

        const terminateSession = Effect.fn("AgentLoop.terminateSession")(function* (
          sessionId: SessionId,
        ) {
          const prefix = `${sessionId}:`
          const loopsToClose = yield* loopsSemaphore.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.update(terminatedSessionsRef, (terminated) => {
                const next = new Set(terminated)
                next.add(sessionId)
                return next
              })

              const selected = Array.from((yield* Ref.get(loopsRef)).entries()).filter(([key]) =>
                key.startsWith(prefix),
              )
              yield* Ref.update(loopsRef, (loops) => {
                const next = new Map(loops)
                for (const [key] of selected) {
                  next.delete(key)
                }
                return next
              })
              yield* Ref.update(mutationSemaphoresRef, (semaphores) => {
                const next = new Map(semaphores)
                for (const key of next.keys()) {
                  if (key.startsWith(prefix)) next.delete(key)
                }
                return next
              })
              return selected.map(([, loop]) => loop)
            }),
          )

          yield* Effect.forEach(loopsToClose, closeLoopHandle, {
            concurrency: "unbounded",
            discard: true,
          })
        })

        const restoreSession = Effect.fn("AgentLoop.restoreSession")(function* (
          sessionId: SessionId,
        ) {
          yield* loopsSemaphore.withPermits(1)(
            Ref.update(terminatedSessionsRef, (terminated) => {
              if (!terminated.has(sessionId)) return terminated
              const next = new Set(terminated)
              next.delete(sessionId)
              return next
            }),
          )
        })

        const turnControlOwnerFor = (
          loop: LoopHandle,
          sessionId: SessionId,
          branchId: BranchId,
          stateForQueuePersistence?: LoopState,
        ): CurrentTurnControlOwnerService => ({
          matches: (command) => command.sessionId === sessionId && command.branchId === branchId,
          apply: (command) =>
            Effect.gen(function* () {
              if (command.sessionId !== sessionId || command.branchId !== branchId) {
                return false
              }
              switch (command._tag) {
                case "QueueFollowUp": {
                  const message = Message.Regular.make({
                    id: MessageId.make(Bun.randomUUIDv7()),
                    sessionId: command.sessionId,
                    branchId: command.branchId,
                    role: "user",
                    parts: [new TextPart({ type: "text", text: command.content })],
                    createdAt: yield* DateTime.nowAsDate,
                    metadata: command.metadata,
                  })
                  const currentQueue = yield* SubscriptionRef.get(loop.loopRef).pipe(
                    Effect.map((s) => s.queue),
                  )
                  if (countQueuedFollowUps(currentQueue) >= DEFAULTS.followUpQueueMax) {
                    return yield* new TurnControlError({
                      command: command._tag,
                      message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                    })
                  }
                  const nextQueue = appendFollowUpQueueState(currentQueue, { message })
                  const persist =
                    stateForQueuePersistence === undefined
                      ? loop.persistQueueState(nextQueue)
                      : loop.persistQueueSnapshot(stateForQueuePersistence, nextQueue)
                  yield* persist.pipe(
                    Effect.mapError(
                      (cause) =>
                        new TurnControlError({
                          command: command._tag,
                          message: `Failed to apply ${command._tag} turn-control command`,
                          cause,
                        }),
                    ),
                  )
                  return true
                }
                case "Interject": {
                  const message = Message.Interjection.make({
                    id: MessageId.make(Bun.randomUUIDv7()),
                    sessionId: command.sessionId,
                    branchId: command.branchId,
                    role: "user",
                    parts: [new TextPart({ type: "text", text: command.content })],
                    createdAt: yield* DateTime.nowAsDate,
                  })
                  const nextQueue = appendSteeringItem(
                    yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                    { message },
                  )
                  const persist =
                    stateForQueuePersistence === undefined
                      ? loop.persistQueueState(nextQueue)
                      : loop.persistQueueSnapshot(stateForQueuePersistence, nextQueue)
                  yield* persist.pipe(
                    Effect.mapError(
                      (cause) =>
                        new TurnControlError({
                          command: command._tag,
                          message: `Failed to apply ${command._tag} turn-control command`,
                          cause,
                        }),
                    ),
                  )
                  const state = stateForQueuePersistence ?? (yield* currentRuntimeState(loop))
                  if (state._tag === "Running" && stateForQueuePersistence === undefined) {
                    yield* interruptActiveStream(loop.activeStreamRef)
                  }
                  return true
                }
              }
            }),
        })

        const withQueueMutationOwner = <A, E, R>(
          loop: LoopHandle,
          sessionId: SessionId,
          branchId: BranchId,
          effect: Effect.Effect<A, E, R>,
          stateForQueuePersistence?: LoopState,
        ): Effect.Effect<A, E, R> =>
          extensionTurnControl.withOwner(
            turnControlOwnerFor(loop, sessionId, branchId, stateForQueuePersistence),
            effect,
          )

        const submitTurn = Effect.fn("AgentLoop.submitTurn")(function* (
          command: SubmitTurnCommand,
        ) {
          const loop = yield* getLoop(command.message.sessionId, command.message.branchId)
          const item = buildQueuedTurnItem(command)
          const reservedStart = yield* withQueueMutationOwner(
            loop,
            command.message.sessionId,
            command.message.branchId,
            loop.queueMutationSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const startingState = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.startingState),
                )
                if (startingState !== undefined) {
                  yield* loop.persistQueueSnapshot(
                    startingState,
                    appendFollowUpQueueState(
                      yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                      item,
                    ),
                  )
                  return
                }
                const projectedState = yield* currentRuntimeState(loop)
                if (projectedState._tag !== "Idle") {
                  const nextQueue = appendFollowUpQueueState(
                    yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                    item,
                  )
                  yield* loop.persistQueueCurrentState(nextQueue)
                  return
                }
                const loopState = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.state),
                )
                if (loopState._tag !== "Idle") {
                  const nextQueue = appendFollowUpQueueState(
                    yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                    item,
                  )
                  yield* loop.persistQueueCurrentState(nextQueue)
                  return
                }

                const reservedRunningState = buildRunningState(loopState, item)
                yield* SubscriptionRef.update(loop.loopRef, (s) => ({
                  ...s,
                  startingState: reservedRunningState,
                }))
                return reservedRunningState
              }),
            ),
          )
          if (reservedStart !== undefined) {
            yield* loop
              .dispatch(LoopDriverEvent.Start.make({ item }))
              .pipe(
                Effect.catchEager((error) =>
                  cleanupLoopIfCurrent(
                    command.message.sessionId,
                    command.message.branchId,
                    loop,
                  ).pipe(Effect.andThen(Effect.fail(error))),
                ),
              )
          }
        })

        const runTurn = Effect.fn("AgentLoop.runTurn")(function* (command: RunTurnCommand) {
          const loop = yield* getLoop(command.message.sessionId, command.message.branchId)
          const item = buildQueuedTurnItem(command)
          const start = yield* loop.queueMutationSemaphore.withPermits(1)(
            Effect.gen(function* () {
              const initialState = yield* loop.snapshot
              if (initialState._tag !== "Idle") {
                const nextQueue = appendFollowUpQueueState(
                  yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                  item,
                )
                yield* loop.persistQueueState(nextQueue)
                return undefined
              }
              const idlePersistedBaseline = yield* SubscriptionRef.get(loop.idlePersistedRef)
              const turnFailureBaseline = (yield* SubscriptionRef.get(loop.turnFailureRef)).count
              return { idlePersistedBaseline, turnFailureBaseline }
            }),
          )
          if (start === undefined) {
            return
          }
          yield* loop
            .dispatch(LoopDriverEvent.Start.make({ item }))
            .pipe(
              Effect.catchEager((error) =>
                cleanupLoopIfCurrent(
                  command.message.sessionId,
                  command.message.branchId,
                  loop,
                ).pipe(Effect.andThen(Effect.fail(error))),
              ),
            )

          yield* Effect.raceFirst(
            Effect.raceFirst(
              awaitIdlePersisted(loop, start.idlePersistedBaseline),
              awaitTurnFailure(loop, start.turnFailureBaseline),
            ),
            loop.persistenceFailure,
          ).pipe(
            Effect.catchEager((error) =>
              cleanupLoopIfCurrent(command.message.sessionId, command.message.branchId, loop).pipe(
                Effect.andThen(Effect.fail(error)),
              ),
            ),
          )
          yield* failIfTurnFailedSince(loop, start.turnFailureBaseline)
        })

        const applySteer = Effect.fn("AgentLoop.applySteer")(function* (
          command: ApplySteerCommand,
        ) {
          const loop = yield* getLoop(command.command.sessionId, command.command.branchId)
          const projectedState = yield* currentRuntimeState(loop)

          const wrapDispatch = (event: LoopDriverEvent) =>
            loop
              .dispatch(event)
              .pipe(
                Effect.catchEager((error) =>
                  cleanupLoopIfCurrent(
                    command.command.sessionId,
                    command.command.branchId,
                    loop,
                  ).pipe(Effect.andThen(Effect.fail(error))),
                ),
              )

          switch (command.command._tag) {
            case "SwitchAgent":
              yield* wrapDispatch(
                LoopDriverEvent.SwitchAgent.make({ agent: command.command.agent }),
              )
              return

            case "Cancel":
            case "Interrupt":
              if (
                projectedState._tag === "Running" ||
                projectedState._tag === "WaitingForInteraction"
              ) {
                yield* wrapDispatch(LoopDriverEvent.Interrupt.make({}))
                return
              }
              const loopState = yield* loop.snapshot
              if (loopState._tag === "Running" || loopState._tag === "WaitingForInteraction") {
                yield* wrapDispatch(LoopDriverEvent.Interrupt.make({}))
              }
              return

            case "Interject": {
              const interjectMessage = Message.Interjection.make({
                id: MessageId.make(Bun.randomUUIDv7()),
                sessionId: command.command.sessionId,
                branchId: command.command.branchId,
                role: "user",
                parts: [new TextPart({ type: "text", text: command.command.message })],
                createdAt: yield* DateTime.nowAsDate,
              })
              const item: QueuedTurnItem = {
                message: interjectMessage,
                ...(command.command.agent !== undefined
                  ? { agentOverride: command.command.agent }
                  : {}),
              }
              const shouldInterrupt = yield* loop.queueMutationSemaphore.withPermits(1)(
                Effect.gen(function* () {
                  const nextQueue = appendSteeringItem(
                    yield* SubscriptionRef.get(loop.loopRef).pipe(Effect.map((s) => s.queue)),
                    item,
                  )
                  yield* loop.persistQueueState(nextQueue)
                  const loopState = yield* loop.snapshot
                  return projectedState._tag === "Running" || loopState._tag === "Running"
                }),
              )
              if (shouldInterrupt) {
                yield* interruptActiveStream(loop.activeStreamRef)
              }
              return
            }
          }
        })

        const respondInteraction = Effect.fn("AgentLoop.respondInteraction")(function* (
          command: RespondInteractionCommand,
        ) {
          const loop = yield* findOrRestoreLoop(command.sessionId, command.branchId)
          if (loop === undefined) return
          const projectedState = yield* currentRuntimeState(loop)
          if (projectedState._tag !== "WaitingForInteraction") {
            const state = yield* loop.snapshot
            if (state._tag !== "WaitingForInteraction") return
          }
          yield* loop
            .dispatch(LoopDriverEvent.InteractionResponded.make({ requestId: command.requestId }))
            .pipe(
              Effect.catchEager((error) =>
                cleanupLoopIfCurrent(command.sessionId, command.branchId, loop).pipe(
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            )
        })

        const recordToolResult = Effect.fn("AgentLoop.recordToolResultPhase")(function* (
          command: RecordToolResultCommand,
        ) {
          const mutationSemaphore = yield* getMutationSemaphore(command.sessionId, command.branchId)
          yield* mutationSemaphore
            .withPermits(1)(
              Effect.gen(function* () {
                yield* getLoop(command.sessionId, command.branchId)
                yield* recordToolResultPhase({
                  storage,
                  eventPublisher,
                  commandId: command.commandId ?? makeCommandId(),
                  sessionId: command.sessionId,
                  branchId: command.branchId,
                  toolCallId: command.toolCallId,
                  toolName: command.toolName,
                  output: command.output,
                  ...(command.isError !== undefined ? { isError: command.isError } : {}),
                })
              }),
            )
            .pipe(Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))))
        })

        const invokeTool = Effect.fn("AgentLoop.invokeToolPhase")(function* (
          command: InvokeToolCommand,
        ) {
          const mutationSemaphore = yield* getMutationSemaphore(command.sessionId, command.branchId)
          yield* mutationSemaphore
            .withPermits(1)(
              Effect.gen(function* () {
                const loop = yield* getLoop(command.sessionId, command.branchId)
                const commandId = command.commandId ?? makeCommandId()
                const currentTurnAgent = (yield* currentRuntimeState(loop)).agent
                const environment = yield* loop.resolveTurnProfile

                yield* invokeToolPhase({
                  assistantMessageId: assistantMessageIdForCommand(commandId),
                  toolResultMessageId: toolResultMessageIdForCommand(commandId),
                  toolCallId: toolCallIdForCommand(commandId),
                  toolName: command.toolName,
                  input: command.input,
                  publishEvent: (event) =>
                    eventPublisher.publish(event).pipe(Effect.catchEager(() => Effect.void)),
                  eventPublisher,
                  sessionId: command.sessionId,
                  branchId: command.branchId,
                  currentTurnAgent,
                  toolRunner,
                  extensionRegistry: environment.turnExtensionRegistry,
                  permission: environment.turnPermission,
                  hostCtx: environment.turnHostCtx,
                  resourceManager,
                  storage,
                })
              }),
            )
            .pipe(Effect.catchCause((cause) => Effect.fail(causeToAgentLoopError(cause))))
        })

        const dispatchLoopCommand = Effect.fn("AgentLoop.dispatchLoopCommand")(function* (
          command: LoopCommand,
        ) {
          switch (command._tag) {
            case "SubmitTurn":
              return yield* submitTurn(command)

            case "RunTurn":
              return yield* runTurn(command)

            case "ApplySteer":
              return yield* applySteer(command)

            case "RespondInteraction":
              return yield* respondInteraction(command)

            case "RecordToolResult":
              return yield* recordToolResult(command)

            case "InvokeTool":
              return yield* invokeTool(command)
          }
        })

        const enqueueFollowUp = Effect.fn("AgentLoop.enqueueFollowUp")(function* (
          message: Message,
        ) {
          const existingLoop = yield* findLoop(message.sessionId, message.branchId)
          const loop = existingLoop ?? (yield* getLoop(message.sessionId, message.branchId))
          const item = { message }
          const reservedStart = yield* withQueueMutationOwner(
            loop,
            message.sessionId,
            message.branchId,
            loop.queueMutationSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const currentQueue = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.queue),
                )
                if (countQueuedFollowUps(currentQueue) >= DEFAULTS.followUpQueueMax) {
                  return yield* new AgentLoopError({
                    message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                  })
                }
                if (existingLoop === undefined) {
                  yield* loop.persistQueueState(appendFollowUpQueueState(currentQueue, item))
                  return
                }
                const projectedState = yield* currentRuntimeState(loop)
                const startingState = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.startingState),
                )
                if (startingState !== undefined) {
                  yield* loop.persistQueueSnapshot(
                    startingState,
                    appendFollowUpQueueState(currentQueue, item),
                  )
                  return
                }
                if (projectedState._tag !== "Idle") {
                  yield* loop.persistQueueCurrentState(appendFollowUpQueueState(currentQueue, item))
                  return
                }
                const loopState = yield* SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => s.state),
                )
                if (loopState._tag !== "Idle") {
                  yield* loop.persistQueueCurrentState(appendFollowUpQueueState(currentQueue, item))
                  return
                }
                const reservedRunningState = buildRunningState(loopState, item)
                yield* SubscriptionRef.update(loop.loopRef, (s) => ({
                  ...s,
                  startingState: reservedRunningState,
                }))
                return reservedRunningState
              }),
            ),
          )
          if (reservedStart !== undefined) {
            yield* loop
              .dispatch(LoopDriverEvent.Start.make({ item }))
              .pipe(
                Effect.catchEager((error) =>
                  cleanupLoopIfCurrent(message.sessionId, message.branchId, loop).pipe(
                    Effect.andThen(Effect.fail(error)),
                  ),
                ),
              )
          }
        })

        const service: AgentLoopService = {
          runOnce: Effect.fn("AgentLoop.runOnce")(function* (input) {
            const userMessage = Message.Regular.make({
              id: MessageId.make(Bun.randomUUIDv7()),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: input.prompt })],
              createdAt: yield* DateTime.nowAsDate,
            })

            yield* persistMessageReceived({
              storage,
              eventPublisher,
              message: userMessage,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentRunError({
                    message: `Failed to persist user message for ${input.sessionId}`,
                    cause,
                  }),
              ),
            )

            return yield* service
              .run(userMessage, {
                agentOverride: input.agentName,
                ...(input.runSpec !== undefined ? { runSpec: input.runSpec } : {}),
                ...(input.interactive !== undefined ? { interactive: input.interactive } : {}),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentRunError({
                      message: cause.message,
                      cause,
                    }),
                ),
              )
          }),

          submit: Effect.fn("AgentLoop.submit")(function* (
            message: Message,
            options?: {
              agentOverride?: AgentNameType
              runSpec?: RunSpec
              interactive?: boolean
            },
          ) {
            return yield* dispatchLoopCommand({
              _tag: "SubmitTurn",
              message,
              ...(options?.agentOverride !== undefined
                ? { agentOverride: options.agentOverride }
                : {}),
              ...(options?.runSpec !== undefined ? { runSpec: options.runSpec } : {}),
              ...(options?.interactive !== undefined ? { interactive: options.interactive } : {}),
            })
          }),

          run: Effect.fn("AgentLoop.run")(function* (
            message: Message,
            options?: {
              agentOverride?: AgentNameType
              runSpec?: RunSpec
              interactive?: boolean
            },
          ) {
            return yield* dispatchLoopCommand({
              _tag: "RunTurn",
              message,
              ...(options?.agentOverride !== undefined
                ? { agentOverride: options.agentOverride }
                : {}),
              ...(options?.runSpec !== undefined ? { runSpec: options.runSpec } : {}),
              ...(options?.interactive !== undefined ? { interactive: options.interactive } : {}),
            })
          }),

          steer: (command) => dispatchLoopCommand({ _tag: "ApplySteer", command }),

          drainQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                const terminated = yield* Ref.get(terminatedSessionsRef)
                if (terminated.has(input.sessionId)) {
                  return yield* new AgentLoopError({
                    message: `Session terminated: ${input.sessionId}`,
                  })
                }
                return queueSnapshotFromQueueState(emptyLoopQueueState())
              }

              return yield* loop.queueMutationSemaphore.withPermits(1)(
                Effect.gen(function* () {
                  const queue = yield* SubscriptionRef.get(loop.loopRef).pipe(
                    Effect.map((s) => s.queue),
                  )
                  const snapshot = queueSnapshotFromQueueState(queue)
                  yield* loop.persistQueueState(emptyLoopQueueState())
                  return snapshot
                }),
              )
            }),

          getQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                const terminated = yield* Ref.get(terminatedSessionsRef)
                if (terminated.has(input.sessionId)) {
                  return yield* new AgentLoopError({
                    message: `Session terminated: ${input.sessionId}`,
                  })
                }
                return queueSnapshotFromQueueState(emptyLoopQueueState())
              }

              return yield* loop.queueMutationSemaphore.withPermits(1)(
                SubscriptionRef.get(loop.loopRef).pipe(
                  Effect.map((s) => queueSnapshotFromQueueState(s.queue)),
                ),
              )
            }),

          respondInteraction: (input) =>
            dispatchLoopCommand({ _tag: "RespondInteraction", ...input }),

          recordToolResult: (input) => dispatchLoopCommand({ _tag: "RecordToolResult", ...input }),

          invokeTool: (input) => dispatchLoopCommand({ _tag: "InvokeTool", ...input }),

          getState: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop !== undefined) {
                const state = yield* loop.queueMutationSemaphore.withPermits(1)(
                  SubscriptionRef.get(loop.loopRef).pipe(Effect.map(projectRuntimeState)),
                )
                return state
              }

              // No running loop. Before synthesizing an idle state from
              // persisted events, confirm the session wasn't terminated — the
              // terminated set outlives `closeLoopHandle` and catches the
              // check-then-use race where delete lands between the caller's
              // `requireSessionExists` gate and this fallback.
              const terminated = yield* Ref.get(terminatedSessionsRef)
              if (terminated.has(input.sessionId)) {
                return yield* new AgentLoopError({
                  message: `Session terminated: ${input.sessionId}`,
                })
              }

              return runtimeStateFromLoopState(
                buildIdleState({
                  currentAgent: yield* resolveStoredAgent({
                    storage,
                    sessionId: input.sessionId,
                    branchId: input.branchId,
                  }),
                }),
                emptyLoopQueueState(),
              )
            }),
          watchState: (input) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(input.sessionId, input.branchId)
              return SubscriptionRef.changes(loop.loopRef).pipe(
                Stream.map(projectRuntimeState),
                Stream.interruptWhen(Deferred.await(loop.closed)),
              )
            }),

          terminateSession,
          restoreSession,
        }

        const failTurnControlCommand = (
          command: TurnControlEnvelope,
          cause: Cause.Cause<unknown>,
        ) =>
          Deferred.fail(
            command.ack,
            new TurnControlError({
              command: command._tag,
              message: `Failed to apply ${command._tag} turn-control command`,
              cause: Cause.squash(cause),
            }),
          ).pipe(Effect.asVoid)

        yield* Stream.runForEach(extensionTurnControl.commands, (command) =>
          Effect.gen(function* () {
            const applied = yield* Effect.exit(
              Effect.gen(function* () {
                switch (command._tag) {
                  case "QueueFollowUp": {
                    const message = Message.Regular.make({
                      id: MessageId.make(Bun.randomUUIDv7()),
                      sessionId: command.sessionId,
                      branchId: command.branchId,
                      role: "user",
                      parts: [new TextPart({ type: "text", text: command.content })],
                      createdAt: yield* DateTime.nowAsDate,
                      metadata: command.metadata,
                    })
                    yield* enqueueFollowUp(message)
                    return
                  }
                  case "Interject":
                    yield* service.steer({
                      _tag: "Interject",
                      sessionId: command.sessionId,
                      branchId: command.branchId,
                      message: command.content,
                    })
                    return
                }
              }),
            )
            if (applied._tag === "Success") {
              yield* Deferred.succeed(command.ack, undefined).pipe(Effect.asVoid)
              return
            }
            yield* failTurnControlCommand(command, applied.cause)
          }),
        ).pipe(Effect.forkScoped)

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const loops = yield* Ref.get(loopsRef)
            yield* Effect.forEach(Array.from(loops.values()), closeLoopHandle, {
              concurrency: "unbounded",
            })
            yield* Scope.close(loopWatcherScope, Exit.void)
          }),
        )

        return service
      }),
    )

  static Test = (): Layer.Layer<AgentLoop> =>
    Layer.succeed(AgentLoop, {
      runOnce: () => Effect.void,
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      drainQueue: () => Effect.succeed(emptyQueueSnapshot()),
      getQueue: () => Effect.succeed(emptyQueueSnapshot()),
      respondInteraction: () => Effect.void,
      recordToolResult: () => Effect.void,
      invokeTool: () => Effect.void,
      terminateSession: () => Effect.void,
      restoreSession: () => Effect.void,
      getState: () =>
        Effect.succeed(
          LoopRuntimeStateSchema.Idle.make({
            agent: DEFAULT_AGENT_NAME,
            queue: emptyQueueSnapshot(),
          }),
        ),
      watchState: () => Effect.succeed(Stream.empty),
    })
}
