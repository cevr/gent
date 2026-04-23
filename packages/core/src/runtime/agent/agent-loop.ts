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
  type AnyInspectionEvent,
  ActorScope,
  combineInspectors,
  InspectorService,
  Machine,
  makeInspectorEffect,
  tracingInspector,
} from "effect-machine"
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
  MachineInspected,
  type AgentEvent,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import {
  Message,
  TextPart,
  ToolCallPart,
  type ImagePart,
  type ReasoningPart,
  type ToolResultPart,
} from "../../domain/message.js"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../domain/ids.js"
import { makeToolContext } from "../../domain/tool.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import { makeAmbientExtensionHostContextDeps } from "../make-extension-host-context.js"
import { ConfigService } from "../config-service.js"
import type { InteractionPendingError } from "../../domain/interaction-request.js"
import type { PromptSection } from "../../server/system-prompt.js"
import { DEFAULTS } from "../../domain/defaults.js"
import { Storage, type StorageError, type StorageService } from "../../storage/sqlite-storage.js"
import { CheckpointStorage } from "../../storage/checkpoint-storage.js"
import {
  Provider,
  providerRequestFromMessages,
  type ProviderError,
  type ProviderStreamPart,
  type ProviderService,
} from "../../providers/provider.js"
import {
  normalizeResponseParts,
  responsePartsToMessageParts,
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
import { ExtensionTurnControl } from "../extensions/turn-control.js"
import { withWideEvent, WideEvent, providerStreamBoundary } from "../wide-event-boundary"
import type { TurnError, TurnEvent } from "../../domain/driver.js"
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
  AgentLoopEvent,
  AgentLoopState,
  appendFollowUpQueueState,
  appendSteeringItem,
  buildIdleState,
  buildRunningState,
  countQueuedFollowUps,
  emptyLoopQueueState,
  isLoopRuntimeIdle,
  LoopRuntimeStateSchema,
  queueSnapshotFromQueueState,
  runtimeStateFromLoopState,
  takeNextQueuedTurn,
  toWaitingForInteractionState,
  updateCurrentAgentOnState,
  type LoopQueueState,
  type AssistantDraft,
  type LoopActor,
  type LoopRuntimeState,
  type LoopState,
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
import { compileSystemPrompt } from "../../server/system-prompt.js"
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

export type ActiveStreamHandle = {
  abortController: AbortController
  interruptDeferred: Deferred.Deferred<void>
  interruptedRef: Ref.Ref<boolean>
}

/** Mutable accumulator for per-turn wide event fields. */
export type TurnMetrics = {
  agent: string
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

const toolCallsFromAssistantParts = (
  parts: ReadonlyArray<AssistantResponsePart>,
): ReadonlyArray<ToolCallPart> =>
  parts.filter((part): part is ToolCallPart => part.type === "tool-call")

const persistMessageParts = (params: {
  storage: StorageService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  role: "assistant" | "tool"
  parts: ReadonlyArray<Message["parts"][number]>
  createdAt?: Date
}) =>
  Effect.gen(function* () {
    if (params.parts.length === 0) return undefined

    const message = new Message({
      id: params.messageId,
      sessionId: params.sessionId,
      branchId: params.branchId,
      role: params.role,
      parts: [...params.parts],
      createdAt: params.createdAt ?? (yield* DateTime.nowAsDate),
    })

    const existing = yield* params.storage.getMessage(message.id)
    if (existing !== undefined) return existing

    yield* params.storage.createMessageIfAbsent(message)
    yield* params
      .publishEvent(
        new MessageReceived({
          sessionId: params.sessionId,
          branchId: params.branchId,
          messageId: message.id,
          role: params.role,
        }),
      )
      .pipe(Effect.orDie)
    return message
  })

const persistAssistantParts = (params: {
  storage: StorageService
  publishEvent: PublishEvent
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
      publishEvent: params.publishEvent,
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
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  messageId: MessageId
  parts: ReadonlyArray<ToolResultPart>
  createdAt?: Date
}) =>
  persistMessageParts({
    storage: params.storage,
    publishEvent: params.publishEvent,
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
          new ErrorOccurred({
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
        ? new AgentDefinition({ ...effectiveAgent, driver: driverResolution.driver })
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
  readonly messages: TurnResponseMessages
  readonly interrupted: boolean
  readonly streamFailed: boolean
}

const isCollectedTurnResponse = (value: unknown): value is CollectedTurnResponse =>
  typeof value === "object" &&
  value !== null &&
  "messages" in value &&
  "interrupted" in value &&
  "streamFailed" in value

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
}): CollectedTurnResponse => {
  const normalized = normalizeResponseParts(params.responseParts)
  const messages = responsePartsToMessageParts(normalized)
  const usage = normalized
    .filter((part): part is Response.FinishPart => part.type === "finish")
    .map((part) => finishedUsage(part.usage))
    .find((part) => part !== undefined)

  return {
    messages: {
      assistant: messages.assistant,
      tool: messages.tool,
      ...(usage !== undefined ? { usage } : {}),
    },
    interrupted: params.interrupted,
    streamFailed: params.streamFailed,
  }
}

const collectModelTurnResponse = (params: {
  turnStream: Stream.Stream<ProviderStreamPart, ProviderError>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: ProviderError) => string
}) =>
  Effect.gen(function* () {
    const responseParts: Response.AnyPart[] = []

    const streamFailed = yield* Stream.runForEach(
      params.turnStream.pipe(
        Stream.interruptWhen(Deferred.await(params.activeStream.interruptDeferred)),
      ),
      (part) =>
        Effect.gen(function* () {
          responseParts.push(part)
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
          yield* Effect.logWarning("stream error, persisting partial output").pipe(
            Effect.annotateLogs({ error: String(streamError) }),
          )
          yield* params
            .publishEvent(
              new StreamEnded({ sessionId: params.sessionId, branchId: params.branchId }),
            )
            .pipe(Effect.orDie)
          yield* params
            .publishEvent(
              new ErrorOccurred({
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
    return collectNormalizedResponse({ responseParts, streamFailed, interrupted })
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
              responseParts.push(
                Response.makePart("tool-call", {
                  id: event.toolCallId,
                  name: event.toolName,
                  params: event.input,
                  providerExecuted: false,
                }),
              )
              return
            case "tool-started":
              yield* params
                .publishEvent(
                  new ToolCallStarted({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.of(event.toolCallId),
                    toolName: event.toolName,
                  }),
                )
                .pipe(Effect.orDie)
              return
            case "tool-completed":
              yield* params
                .publishEvent(
                  new ToolCallSucceeded({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.of(event.toolCallId),
                    toolName: "external",
                  }),
                )
                .pipe(Effect.orDie)
              return
            case "tool-failed":
              yield* params
                .publishEvent(
                  new ToolCallFailed({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.of(event.toolCallId),
                    toolName: "external",
                    output: event.error,
                  }),
                )
                .pipe(Effect.orDie)
              return
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
              new StreamEnded({ sessionId: params.sessionId, branchId: params.branchId }),
            )
            .pipe(Effect.orDie)
          yield* params
            .publishEvent(
              new ErrorOccurred({
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
    return collectNormalizedResponse({ responseParts, streamFailed, interrupted })
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
          new ToolCallStarted({
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
          isError ? new ToolCallFailed(toolCallFields) : new ToolCallSucceeded(toolCallFields),
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
  baseSections: ReadonlyArray<PromptSection>
  interactive?: boolean
  hostCtx: ExtensionHostContext
}) =>
  Effect.gen(function* () {
    const existing = yield* params.storage.getMessage(params.message.id)
    if (existing === undefined) {
      yield* params.storage.createMessageIfAbsent(params.message)
      yield* params
        .publishEvent(
          new MessageReceived({
            sessionId: params.sessionId,
            branchId: params.branchId,
            messageId: params.message.id,
            role: "user",
          }),
        )
        .pipe(Effect.orDie)
    }

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
  readonly stream: Stream.Stream<ProviderStreamPart, ProviderError>
  readonly formatStreamError: (streamError: ProviderError) => string
  readonly collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
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
            new ErrorOccurred({
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

    const streamEffect = yield* withRetry(
      params.provider.stream(
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
      ),
      undefined,
      {
        onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
          params
            .publishEvent(
              new ProviderRetrying({
                sessionId: params.sessionId,
                branchId: params.branchId,
                attempt,
                maxAttempts,
                delayMs,
                error: error.message,
              }),
            )
            .pipe(Effect.orDie),
      },
    )

    return {
      driverKind: "model" as const,
      stream: streamEffect,
      formatStreamError: formatStreamErrorMessage,
      collect: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const result = yield* effect
          if (isCollectedTurnResponse(result)) {
            const collected: CollectedTurnResponse = result
            yield* WideEvent.set({
              inputTokens: collected.messages.usage?.inputTokens ?? 0,
              outputTokens: collected.messages.usage?.outputTokens ?? 0,
              toolCallCount: toolCallsFromAssistantParts(collected.messages.assistant).length,
              interrupted: collected.interrupted,
              streamFailed: collected.streamFailed,
            })
          }
          return result
        }).pipe(withWideEvent(providerStreamBoundary(resolved.modelId))),
    } satisfies ModelTurnSource
  })

const runTurnStreamPhase = (params: {
  messageId: MessageId
  step: number
  resolved: ResolvedTurnContext
  provider: ProviderService
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  extensionRegistry: ExtensionRegistryService
  driverRegistry: DriverRegistryService
  storage: StorageService
  hostCtx: ExtensionHostContext
  turnMetrics?: Ref.Ref<TurnMetrics>
}) =>
  Effect.gen(function* () {
    const persistAssistantPartsLocal = (
      parts: ReadonlyArray<AssistantResponsePart>,
      createdAt?: Date,
    ) =>
      persistAssistantParts({
        storage: params.storage,
        publishEvent: params.publishEvent,
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
        publishEvent: params.publishEvent,
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
      return {
        messages: { assistant: [], tool: [] },
        interrupted: false,
        streamFailed: true,
      }
    }

    yield* params
      .publishEvent(new StreamStarted({ sessionId: params.sessionId, branchId: params.branchId }))
      .pipe(Effect.orDie)

    yield* Effect.logInfo("turn-stream.start").pipe(
      Effect.annotateLogs({
        agent: params.resolved.currentTurnAgent,
        driverKind: source.driverKind,
        model: params.resolved.modelId,
        ...(source.driverId !== undefined ? { driverId: source.driverId } : {}),
      }),
    )

    const collect =
      source.driverKind === "model"
        ? collectModelTurnResponse({
            turnStream: source.stream,
            publishEvent: params.publishEvent,
            sessionId: params.sessionId,
            branchId: params.branchId,
            activeStream: params.activeStream,
            formatStreamError: source.formatStreamError,
          })
        : collectExternalTurnResponse({
            turnStream: source.stream,
            publishEvent: params.publishEvent,
            sessionId: params.sessionId,
            branchId: params.branchId,
            activeStream: params.activeStream,
            formatStreamError: source.formatStreamError,
          })

    const collected = yield* source.collect(collect)

    if (collected.interrupted) {
      yield* params
        .publishEvent(
          new StreamEnded({
            sessionId: params.sessionId,
            branchId: params.branchId,
            interrupted: true,
          }),
        )
        .pipe(Effect.orDie)
      yield* persistAssistantPartsLocal(collected.messages.assistant)
      return collected
    }

    if (collected.streamFailed) return collected

    yield* params
      .publishEvent(
        new StreamEnded({
          sessionId: params.sessionId,
          branchId: params.branchId,
          ...(collected.messages.usage !== undefined ? { usage: collected.messages.usage } : {}),
        }),
      )
      .pipe(Effect.orDie)
    yield* Effect.logInfo("stream.end").pipe(
      Effect.annotateLogs({
        driverKind: source.driverKind,
        inputTokens: collected.messages.usage?.inputTokens ?? 0,
        outputTokens: collected.messages.usage?.outputTokens ?? 0,
        toolCallCount: toolCallsFromAssistantParts(collected.messages.assistant).length,
      }),
    )

    if (params.turnMetrics !== undefined) {
      yield* Ref.update(params.turnMetrics, (m) => ({
        ...m,
        agent: params.resolved.currentTurnAgent,
        model: params.resolved.modelId,
        inputTokens: m.inputTokens + (collected.messages.usage?.inputTokens ?? 0),
        outputTokens: m.outputTokens + (collected.messages.usage?.outputTokens ?? 0),
        toolCallCount:
          m.toolCallCount + toolCallsFromAssistantParts(collected.messages.assistant).length,
      }))
    }

    yield* persistAssistantPartsLocal(collected.messages.assistant)
    yield* persistToolPartsLocal(collected.messages.tool)

    return collected
  })

const executeToolsPhase = (params: {
  messageId: MessageId
  step: number
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
      publishEvent: params.publishEvent,
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
      publishEvent: params.publishEvent,
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
      publishEvent: params.publishEvent,
      sessionId: params.sessionId,
      branchId: params.branchId,
      messageId: params.toolResultMessageId,
      parts: toolResults,
    })
  })

const finalizeTurnPhase = (params: {
  storage: StorageService
  publishEvent: PublishEvent
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
    if (existingMessage?.turnDurationMs !== undefined) return

    const turnEndTime = yield* DateTime.now
    const turnDurationMs = DateTime.toEpochMillis(turnEndTime) - params.startedAtMs

    yield* params.storage.updateMessageTurnDuration(params.messageId, turnDurationMs)
    yield* params
      .publishEvent(
        new TurnCompleted({
          sessionId: params.sessionId,
          branchId: params.branchId,
          durationMs: Number(turnDurationMs),
          ...(params.turnInterrupted ? { interrupted: true } : {}),
        }),
      )
      .pipe(Effect.orDie)

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

const LoopCommand = Schema.Union([
  SubmitTurnCommand,
  RunTurnCommand,
  ApplySteerCommand,
  RespondInteractionCommand,
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

  return new AgentDefinition({
    ...agent,
    ...(overrides?.allowedTools !== undefined ? { allowedTools: overrides.allowedTools } : {}),
    ...(overrides?.deniedTools !== undefined ? { deniedTools: overrides.deniedTools } : {}),
    ...(overrides?.reasoningEffort !== undefined
      ? { reasoningEffort: overrides.reasoningEffort }
      : {}),
    ...(systemPromptAddendum !== agent.systemPromptAddendum ? { systemPromptAddendum } : {}),
  })
}

type LoopHandle = {
  actor: LoopActor
  activeStreamRef: Ref.Ref<ActiveStreamHandle | undefined>
  queueRef: Ref.Ref<LoopQueueState>
  runtimeStateRef: SubscriptionRef.SubscriptionRef<LoopRuntimeState>
  persistState: (state: LoopState) => Effect.Effect<void>
  refreshRuntimeState: Effect.Effect<void>
  updateQueue: (update: (queue: LoopQueueState) => LoopQueueState) => Effect.Effect<void>
  resourceManager: ResourceManagerService
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
      Effect.catchEager((error) =>
        Effect.logWarning("failed to publish ErrorOccurred").pipe(
          Effect.annotateLogs({ error: String(error) }),
        ),
      ),
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
              Effect.logWarning("failed to publish MachineInspected").pipe(
                Effect.annotateLogs({ error: String(error) }),
              ),
            ),
          ),
    ),
  )

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
              new TurnRecoveryApplied({
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
  readonly respondInteraction: (input: {
    sessionId: SessionId
    branchId: BranchId
    requestId: string
  }) => Effect.Effect<void>
  readonly getActor: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<LoopActor>
  readonly getState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<LoopRuntimeState>
  readonly watchState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<Stream.Stream<LoopRuntimeState>>
  readonly toRuntimeState: (state: LoopState, queue: LoopQueueState) => LoopRuntimeState
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
        const loopsRef = yield* Ref.make<Map<string, LoopHandle>>(new Map())
        const loopsSemaphore = yield* Semaphore.make(1)

        const stateKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`

        const makeLoop = (
          sessionId: SessionId,
          branchId: BranchId,
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
              overrides: {
                eventPublisher,
              },
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
            const queueRef = yield* Ref.make(initialQueue)
            const runtimeStateRef = yield* SubscriptionRef.make(
              runtimeStateFromLoopState(buildIdleState({ currentAgent }), initialQueue),
            )
            let loopActor: LoopActor | undefined
            const inspector = makePublishingInspector({
              publishEvent: publishEventOrDie,
              sessionId,
              branchId,
            })

            const persistRuntimeState = (state: LoopState) =>
              Effect.gen(function* () {
                const queue = yield* Ref.get(queueRef)
                yield* SubscriptionRef.set(runtimeStateRef, runtimeStateFromLoopState(state, queue))

                yield* Effect.logDebug("checkpoint.save.start").pipe(
                  Effect.annotateLogs({ nextState: state._tag }),
                )
                if (!shouldRetainLoopCheckpoint({ state, queue })) {
                  yield* checkpointStorage.remove({ sessionId, branchId })
                  yield* Effect.logDebug("checkpoint.save.removed")
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
              }).pipe(
                Effect.catchEager((error) =>
                  Effect.logWarning("checkpoint.save failed").pipe(
                    Effect.annotateLogs({ error: String(error) }),
                  ),
                ),
              )

            const refreshRuntimeState = Effect.gen(function* () {
              if (loopActor === undefined) return
              yield* persistRuntimeState(yield* loopActor.snapshot)
            })

            const updateQueue = (update: (queue: LoopQueueState) => LoopQueueState) =>
              Effect.gen(function* () {
                yield* Ref.update(queueRef, update)
                yield* refreshRuntimeState
              })

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
                  new AgentSwitched({
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
                      return AgentLoopEvent.InteractionRequested({
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
                  storage,
                  sessionId,
                  branchId,
                  activeStream,
                  turnMetrics: turnMetricsRef,
                }).pipe(Effect.ensuring(Ref.set(activeStreamRef, undefined)))

                if (collected.interrupted) {
                  interrupted = true
                  break
                }
                if (collected.streamFailed) {
                  streamFailed = true
                  break
                }

                // No tool calls → LLM is done
                const toolCalls = toolCallsFromAssistantParts(collected.messages.assistant)
                if (toolCalls.length === 0) break

                // 3. Execute tools
                const interactionSignal = yield* executeToolsPhase({
                  messageId: state.message.id,
                  step,
                  toolCalls,
                  publishEvent: publishEventOrDie,
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
                  return AgentLoopEvent.InteractionRequested({
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
                publishEvent: publishEventOrDie,
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

              return AgentLoopEvent.TurnDone
            })

            const loopMachine = Machine.make({
              state: AgentLoopState,
              event: AgentLoopEvent,
              initial: buildIdleState({ currentAgent }),
            })
              // Idle → Running
              .on(AgentLoopState.Idle, AgentLoopEvent.Start, ({ state, event }) =>
                buildRunningState(state, event.item),
              )
              .on(
                [AgentLoopState.Idle, AgentLoopState.Running, AgentLoopState.WaitingForInteraction],
                AgentLoopEvent.SwitchAgent,
                ({ state, event }) => switchAgentOnState(state, event.agent),
              )
              .on(AgentLoopState.Idle, AgentLoopEvent.Interrupt, ({ state }) => state)
              .on(AgentLoopState.Running, AgentLoopEvent.Interrupt, ({ state }) =>
                Effect.gen(function* () {
                  yield* Ref.set(interruptedRef, true)
                  yield* interruptActiveStream(activeStreamRef)
                  return state
                }),
              )
              // Running → Idle (turn done), or re-enter Running (queued follow-up)
              .reenter(AgentLoopState.Running, AgentLoopEvent.TurnDone, ({ state }) =>
                Effect.gen(function* () {
                  const { queue, nextItem } = takeNextQueuedTurn(yield* Ref.get(queueRef))
                  yield* Ref.set(queueRef, queue)
                  if (nextItem !== undefined) {
                    yield* Ref.set(interruptedRef, false)
                    return buildRunningState({ currentAgent: state.currentAgent }, nextItem)
                  }
                  yield* Ref.set(interruptedRef, false)
                  return buildIdleState({ currentAgent: state.currentAgent })
                }),
              )
              .on(AgentLoopState.Running, AgentLoopEvent.TurnFailed, ({ state }) =>
                Effect.gen(function* () {
                  const { queue, nextItem } = takeNextQueuedTurn(yield* Ref.get(queueRef))
                  yield* Ref.set(queueRef, queue)
                  yield* Ref.set(interruptedRef, false)
                  if (nextItem !== undefined) {
                    return buildRunningState({ currentAgent: state.currentAgent }, nextItem)
                  }
                  return buildIdleState({ currentAgent: state.currentAgent })
                }),
              )
              // Running → WaitingForInteraction
              .on(AgentLoopState.Running, AgentLoopEvent.InteractionRequested, ({ state, event }) =>
                toWaitingForInteractionState({
                  state,
                  currentTurnAgent: event.currentTurnAgent,
                  pendingRequestId: event.pendingRequestId,
                  pendingToolCallId: event.pendingToolCallId,
                }),
              )
              // WaitingForInteraction — cold state, no task fiber
              .on(AgentLoopState.WaitingForInteraction, AgentLoopEvent.Interrupt, ({ state }) =>
                Effect.gen(function* () {
                  // Transition to Running with interrupt set — task will finalize immediately
                  yield* Ref.set(interruptedRef, true)
                  return AgentLoopState.Running.with(state, {
                    message: state.message,
                    startedAtMs: state.startedAtMs,
                    agentOverride: state.agentOverride,
                    runSpec: state.runSpec,
                    interactive: state.interactive,
                  })
                }),
              )
              // WaitingForInteraction → Running (resume)
              .on(
                AgentLoopState.WaitingForInteraction,
                AgentLoopEvent.InteractionResponded,
                ({ state }) =>
                  AgentLoopState.Running.with(state, {
                    message: state.message,
                    startedAtMs: state.startedAtMs,
                    agentOverride: state.agentOverride,
                    runSpec: state.runSpec,
                    interactive: state.interactive,
                  }),
              )
              // Running task — the agentic loop
              .task(
                AgentLoopState.Running,
                ({ state }) =>
                  runTurn(state).pipe(
                    Effect.annotateLogs({ sessionId, branchId }),
                    Effect.withSpan("AgentLoop.turn"),
                    Effect.tapCause((cause) =>
                      publishPhaseFailure({ publishEvent, sessionId, branchId, cause }),
                    ),
                  ),
                { name: "turn", onFailure: () => AgentLoopEvent.TurnFailed },
              )

            const spawnedLoopActor = yield* Machine.spawn(loopMachine, {
              id: `agent-loop:${sessionId}:${branchId}`,
              lifecycle: {
                recovery: {
                  resolve: (_ctx) =>
                    Effect.withSpan("AgentLoop.recovery.resolve")(
                      Effect.gen(function* () {
                        const record = yield* checkpointStorage.get({ sessionId, branchId })
                        if (record === undefined) return Option.none<LoopState>()
                        if (record.version !== AGENT_LOOP_CHECKPOINT_VERSION) {
                          yield* checkpointStorage.remove({ sessionId, branchId })
                          return Option.none<LoopState>()
                        }
                        const decoded = yield* Effect.option(
                          decodeLoopCheckpointState(record.stateJson),
                        )
                        if (Option.isNone(decoded)) {
                          yield* checkpointStorage.remove({ sessionId, branchId })
                          return Option.none<LoopState>()
                        }
                        const recovered = yield* makeRecoveryDecision({
                          checkpoint: decoded.value,
                          storage,
                          extensionRegistry,
                          currentAgent,
                          publishEvent: publishEventOrDie,
                          sessionId,
                          branchId,
                        }).pipe(
                          Effect.catchEager(() =>
                            Effect.succeed(Option.none<LoopRecoveryDecision>()),
                          ),
                        )
                        if (Option.isNone(recovered)) {
                          return Option.none<LoopState>()
                        }
                        yield* Ref.set(queueRef, recovered.value.queue)
                        yield* SubscriptionRef.set(
                          runtimeStateRef,
                          runtimeStateFromLoopState(recovered.value.state, recovered.value.queue),
                        )
                        return Option.some(recovered.value.state)
                      }).pipe(Effect.catchEager(() => Effect.succeed(Option.none<LoopState>()))),
                    ),
                },
                durability: {
                  save: (commit) =>
                    Effect.withSpan("AgentLoop.durability.save")(
                      persistRuntimeState(commit.nextState),
                    ),
                },
              },
            }).pipe(
              Effect.provideService(InspectorService, inspector),
              Effect.provideService(ActorScope, loopScope),
            )
            loopActor = spawnedLoopActor

            return {
              actor: spawnedLoopActor,
              activeStreamRef,
              queueRef,
              runtimeStateRef,
              persistState: persistRuntimeState,
              refreshRuntimeState,
              updateQueue,
              resourceManager,
              scope: loopScope,
            }
          })

        const getLoop = Effect.fn("AgentLoop.getLoop")(function* (
          sessionId: SessionId,
          branchId: BranchId,
        ) {
          const key = stateKey(sessionId, branchId)
          // Allocate + register under semaphore, then start outside.
          // Machine.spawn returns an unstarted actor — fibers don't run
          // until actor.start. This prevents the self-deadlock where
          // background fibers re-enter getLoop before the handle is
          // installed in loopsRef.
          const created = yield* Effect.withSpan("AgentLoop.getLoop.semaphore")(
            loopsSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const existing = (yield* Ref.get(loopsRef)).get(key)
                if (existing !== undefined) return undefined
                const handle = yield* makeLoop(sessionId, branchId)
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
            yield* created.actor.start
            yield* created.refreshRuntimeState
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

        const currentRuntimeState = (loop: LoopHandle) => SubscriptionRef.get(loop.runtimeStateRef)

        const submitTurn = Effect.fn("AgentLoop.submitTurn")(function* (
          command: SubmitTurnCommand,
        ) {
          const loop = yield* getLoop(command.message.sessionId, command.message.branchId)
          const item = buildQueuedTurnItem(command)
          const loopState = yield* loop.actor.snapshot
          if (loopState._tag !== "Idle") {
            yield* loop.updateQueue((queue) => appendFollowUpQueueState(queue, item))
            return
          }

          yield* loop.actor.call(AgentLoopEvent.Start({ item }))
        })

        const runTurn = Effect.fn("AgentLoop.runTurn")(function* (command: RunTurnCommand) {
          const loop = yield* getLoop(command.message.sessionId, command.message.branchId)
          const item = buildQueuedTurnItem(command)
          const initialState = yield* loop.actor.snapshot
          if (initialState._tag !== "Idle") {
            yield* loop.updateQueue((queue) => appendFollowUpQueueState(queue, item))
            return
          }

          yield* loop.actor.send(AgentLoopEvent.Start({ item }))
          yield* loop.actor.waitFor((state) => state._tag === "Idle" && state !== initialState)
        })

        const dispatchLoopCommand = Effect.fn("AgentLoop.dispatchLoopCommand")(function* (
          command: LoopCommand,
        ) {
          switch (command._tag) {
            case "SubmitTurn":
              return yield* submitTurn(command)

            case "RunTurn":
              return yield* runTurn(command)

            case "ApplySteer": {
              const loop = yield* getLoop(command.command.sessionId, command.command.branchId)
              const projectedState = yield* currentRuntimeState(loop)

              switch (command.command._tag) {
                case "SwitchAgent":
                  yield* loop.actor.cast(
                    AgentLoopEvent.SwitchAgent({ agent: command.command.agent }),
                  )
                  return
                case "Cancel":
                case "Interrupt":
                  if (
                    projectedState._tag === "Running" ||
                    projectedState._tag === "WaitingForInteraction"
                  ) {
                    yield* loop.actor.cast(AgentLoopEvent.Interrupt)
                    return
                  }
                  const loopState = yield* loop.actor.snapshot
                  if (loopState._tag === "Running" || loopState._tag === "WaitingForInteraction") {
                    yield* loop.actor.cast(AgentLoopEvent.Interrupt)
                  }
                  return
                case "Interject": {
                  const interjectMessage = new Message({
                    id: MessageId.of(Bun.randomUUIDv7()),
                    sessionId: command.command.sessionId,
                    branchId: command.command.branchId,
                    kind: "interjection",
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
                  yield* loop.updateQueue((queue) => appendSteeringItem(queue, item))
                  if (projectedState._tag === "Running") {
                    yield* interruptActiveStream(loop.activeStreamRef)
                    return
                  }
                  const loopState = yield* loop.actor.snapshot
                  if (loopState._tag === "Running") {
                    yield* interruptActiveStream(loop.activeStreamRef)
                  }
                  return
                }
              }
            }

            case "RespondInteraction": {
              const loop = yield* findOrRestoreLoop(command.sessionId, command.branchId)
              if (loop === undefined) return
              const projectedState = yield* currentRuntimeState(loop)
              if (projectedState._tag !== "WaitingForInteraction") {
                const state = yield* loop.actor.snapshot
                if (state._tag !== "WaitingForInteraction") return
              }
              yield* loop.actor.call(
                AgentLoopEvent.InteractionResponded({ requestId: command.requestId }),
              )
              return
            }
          }
        })

        const service: AgentLoopService = {
          runOnce: Effect.fn("AgentLoop.runOnce")(function* (input) {
            const userMessage = new Message({
              id: MessageId.of(Bun.randomUUIDv7()),
              sessionId: input.sessionId,
              branchId: input.branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: input.prompt })],
              createdAt: yield* DateTime.nowAsDate,
            })

            yield* storage.createMessage(userMessage).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentRunError({
                    message: `Failed to create user message for ${input.sessionId}`,
                    cause,
                  }),
              ),
            )
            yield* eventPublisher
              .publish(
                new MessageReceived({
                  sessionId: input.sessionId,
                  branchId: input.branchId,
                  messageId: userMessage.id,
                  role: "user",
                }),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentRunError({
                      message: `Failed to publish MessageReceived for ${input.sessionId}`,
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

          followUp: (message) =>
            Effect.gen(function* () {
              const existingLoop = yield* findLoop(message.sessionId, message.branchId)
              const loop = existingLoop ?? (yield* getLoop(message.sessionId, message.branchId))
              const queue = yield* Ref.get(loop.queueRef)
              if (countQueuedFollowUps(queue) >= DEFAULTS.followUpQueueMax) {
                return yield* new AgentLoopError({
                  message: `Follow-up queue full (max ${DEFAULTS.followUpQueueMax})`,
                })
              }
              const item = { message }
              if (existingLoop === undefined) {
                yield* loop.updateQueue((nextQueue) => appendFollowUpQueueState(nextQueue, item))
                return
              }
              const loopState = yield* loop.actor.snapshot
              if (loopState._tag !== "Idle") {
                yield* loop.updateQueue((nextQueue) => appendFollowUpQueueState(nextQueue, item))
                return
              }
              yield* loop.actor.call(AgentLoopEvent.Start({ item }))
            }),

          drainQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                return queueSnapshotFromQueueState(emptyLoopQueueState())
              }

              const queue = yield* Ref.get(loop.queueRef)
              const snapshot = queueSnapshotFromQueueState(queue)
              yield* Ref.set(loop.queueRef, emptyLoopQueueState())
              yield* loop.refreshRuntimeState
              return snapshot
            }),

          getQueue: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) {
                return queueSnapshotFromQueueState(emptyLoopQueueState())
              }

              return queueSnapshotFromQueueState(yield* Ref.get(loop.queueRef))
            }),

          isRunning: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop === undefined) return false
              return !isLoopRuntimeIdle(
                runtimeStateFromLoopState(
                  yield* loop.actor.snapshot,
                  yield* Ref.get(loop.queueRef),
                ),
              )
            }),

          respondInteraction: (input) =>
            dispatchLoopCommand({ _tag: "RespondInteraction", ...input }),

          getActor: (input) =>
            Effect.gen(function* () {
              const loop = yield* getLoop(input.sessionId, input.branchId)
              return loop.actor
            }),

          getState: (input) =>
            Effect.gen(function* () {
              const loop = yield* findOrRestoreLoop(input.sessionId, input.branchId)
              if (loop !== undefined) {
                const state = runtimeStateFromLoopState(
                  yield* loop.actor.snapshot,
                  yield* Ref.get(loop.queueRef),
                )
                yield* SubscriptionRef.set(loop.runtimeStateRef, state)
                return state
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
              return SubscriptionRef.changes(loop.runtimeStateRef)
            }),
          toRuntimeState: runtimeStateFromLoopState,
        }

        yield* Stream.runForEach(extensionTurnControl.commands, (command) =>
          Effect.gen(function* () {
            switch (command._tag) {
              case "QueueFollowUp": {
                const message = new Message({
                  id: MessageId.of(Bun.randomUUIDv7()),
                  sessionId: command.sessionId,
                  branchId: command.branchId,
                  kind: "regular",
                  role: "user",
                  parts: [new TextPart({ type: "text", text: command.content })],
                  createdAt: yield* DateTime.nowAsDate,
                  metadata: command.metadata,
                })
                yield* service.followUp(message).pipe(Effect.catchEager(() => Effect.void))
                return
              }
              case "Interject":
                yield* service
                  .steer({
                    _tag: "Interject",
                    sessionId: command.sessionId,
                    branchId: command.branchId,
                    message: command.content,
                  })
                  .pipe(Effect.catchEager(() => Effect.void))
                return
            }
          }),
        ).pipe(Effect.forkScoped)

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
      runOnce: () => Effect.void,
      submit: () => Effect.void,
      run: () => Effect.void,
      steer: () => Effect.void,
      followUp: () => Effect.void,
      drainQueue: () => Effect.succeed(emptyQueueSnapshot()),
      getQueue: () => Effect.succeed(emptyQueueSnapshot()),
      isRunning: (_input) => Effect.succeed(false),
      respondInteraction: () => Effect.void,
      getActor: () => Effect.die("AgentLoop.Test.getActor not implemented"),
      getState: () =>
        Effect.succeed(
          new LoopRuntimeStateSchema.Idle({
            agent: DEFAULT_AGENT_NAME,
            queue: emptyQueueSnapshot(),
          }),
        ),
      watchState: () => Effect.succeed(Stream.empty),
      toRuntimeState: runtimeStateFromLoopState,
    })
}
